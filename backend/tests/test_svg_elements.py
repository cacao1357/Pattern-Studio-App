"""Visual SVG edits preserve holes, exact curves, immutable history and exports."""
from io import BytesIO
import json
import zipfile
from uuid import uuid4
from unittest.mock import patch
import xml.etree.ElementTree as ET

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import SecretStr, ValidationError
from svg.path import parse_path, Move

from app.config import Settings
from app.main import create_app
from app.schemas.svg_edit import EditSvgRequest, ElementEdit
from app.services.svg_elements import describe_svg, apply_edits
from app.services.local_workbench import execute_local
from app.storage import ServiceError, png_bytes
from app.worker import LocalWorker
from app.workbench_store import WorkbenchStore


def svg(d, rule="evenodd", transform=""):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">'
            f'<g fill="#123456" fill-rule="{rule}" {transform}><path d="{d}"/></g></svg>')


@pytest.mark.parametrize("rule,hole", [("evenodd", "M20 20h10v10h-10z"),
                                         ("nonzero", "M20 20v10h10v-10z")])
def test_disjoint_shapes_keep_holes_and_relative_moveto(rule, hole):
    source = svg(f"M10 10h30v30h-30z {hole} m40 40h10v10h-10z", rule)
    description = describe_svg(source, (100, 100))
    assert len(description["elements"]) == 2
    donut, separate = description["elements"]
    assert sum(isinstance(s, Move) for s in parse_path(donut["d"])) == 2
    assert parse_path(separate["d"])[0].end == 60+60j
    output, _ = apply_edits(description, [ElementEdit(element_id=donut["id"], dx=5, dy=7),
                                         ElementEdit(element_id=separate["id"], deleted=True)], description["source_sha256"])
    reopened = describe_svg(output, (100, 100))
    assert len(reopened["elements"]) == 1
    assert reopened["elements"][0]["bbox"] == [15, 17, 45, 47]
    assert sum(isinstance(s, Move) for s in parse_path(reopened["elements"][0]["d"])) == 2


def test_adjacent_pixel_rectangles_are_one_element_but_island_is_separate():
    description = describe_svg(svg("M1 1h2v1h-2Z M1 2h2v1h-2Z M80 80h1v1h-1Z", "nonzero"), (100, 100))
    assert len(description["elements"]) == 2
    assert description["elements"][0]["bbox"] == [1, 1, 3, 3]


def test_curve_commands_and_nested_translation_survive_save_and_reopen():
    source = svg("M10.12345678 10 C12.12345678 8 18 8 20 10 L20 30 L10.12345678 30 Z", transform='transform="translate(3,4)"')
    description = describe_svg(source, (100, 100))
    element = description["elements"][0]
    before = parse_path(element["d"])
    assert before[0].end.real == 10.12345678
    assert before[1].control1.real == 12.12345678
    output, _ = apply_edits(description, [ElementEdit(element_id=element["id"], dx=2.5, dy=-1)], description["source_sha256"])
    reopened = describe_svg(output, (100, 100))["elements"][0]
    assert reopened["transform"] == "translate(5.5,3)"
    after = parse_path(reopened["d"])
    for a,b in zip(before, after):
        assert type(a) is type(b)
        assert all(a.point(t) == b.point(t) for t in (0, .25, .5, 1))


def test_nested_island_in_hole_remains_independently_selectable():
    d = "M0 0h90v90h-90z M10 10h70v70h-70z M30 30h10v10h-10z"
    elements = describe_svg(svg(d), (100,100))["elements"]
    assert len(elements) == 2
    assert sorted(sum(isinstance(s, Move) for s in parse_path(e["d"])) for e in elements) == [1,2]


def test_wrong_source_unknown_id_unsafe_geometry_and_nonfinite_edits_are_rejected():
    description = describe_svg(svg("M1 1h10v10h-10z"), (100,100))
    with pytest.raises(ServiceError) as error:
        apply_edits(description, [ElementEdit(element_id="p0c0", dx=1)], "0"*64)
    assert error.value.code == "SVG_EDIT_SOURCE_MISMATCH"
    with pytest.raises(ServiceError) as error:
        apply_edits(description, [ElementEdit(element_id="p99c0")], description["source_sha256"])
    assert error.value.code == "SVG_ELEMENT_NOT_FOUND"
    crossing = describe_svg(svg("M0 0L40 40L40 0L0 40z"), (100,100))
    assert len(crossing["elements"]) == 1
    with pytest.raises(ServiceError) as error:
        describe_svg(svg("M0 0L1 1Z"), (100,100))
    assert error.value.code == "SVG_EDIT_UNSUPPORTED"
    with pytest.raises(ValidationError):
        ElementEdit(element_id="p0c0", dx=float("nan"))


def test_delete_last_element_saves_a_reopenable_empty_svg():
    description = describe_svg(svg("M1 1h10v10h-10z"), (100,100))
    output, metadata = apply_edits(description, [ElementEdit(element_id="p0c0", deleted=True)], description["source_sha256"])
    assert metadata["path_count"] == 0
    assert describe_svg(output, (100,100))["elements"] == []


def test_same_source_components_share_one_paint_operation():
    description = describe_svg(svg("M1 1h10v10h-10z M50 50h10v10h-10z"), (100,100))
    assert len(description["elements"]) == 2
    edits = [ElementEdit(element_id=e["id"], dx=2, dy=3) for e in description["elements"]]
    output, metadata = apply_edits(description, edits, description["source_sha256"])
    assert metadata["path_count"] == 1  # avoid separately antialiasing nearby subpaths
    assert len(describe_svg(output, (100,100))["elements"]) == 2


def test_http_edit_is_idempotent_preserves_source_history_and_zip(tmp_path):
    settings = Settings(api_token=SecretStr(""), ark_api_key=SecretStr(""), storage_root=tmp_path/"api", paid_calls_enabled=False)
    store = WorkbenchStore(settings.storage_root)
    def forbidden(request):
        raise AssertionError("SVG editing attempted a cloud request")
    def headers(key=None):
        return {"X-Pattern-Studio":"local", "Idempotency-Key":key or uuid4().hex}
    with patch.object(LocalWorker,"start"), patch.object(LocalWorker,"stop"), TestClient(
        create_app(settings, transport=httpx.MockTransport(forbidden)), base_url="http://127.0.0.1:8765",
        client=("127.0.0.1",12345)) as client:
        im=Image.new("RGBA",(100,100))
        draw=ImageDraw.Draw(im)
        draw.rectangle((5,5,25,25),fill="#123456")
        draw.rectangle((70,70,85,85),fill="#123456")
        upload=client.post("/api/v1/images", files={"file":("synthetic.png",png_bytes(im),"image/png")}, data={"license":"CC0-1.0"},headers=headers()).json()
        def run(route, body):
            response=client.post("/api/v1/"+route,json=body,headers=headers())
            assert response.status_code==202,response.text
            job,token=store.claim()
            execute_local(store,job["job_id"],token)
            store.finish_job(job["job_id"],token)
            return store.get_job(job["job_id"])["result"]["assets"][0]
        source=run("jobs/vectorize",{"input_asset_id":upload["normalized"]["asset_id"],"mode":"monochrome"})
        source_bytes=store.read_asset(source["asset_id"])[1]
        manifest=client.get(f'/api/v1/assets/{source["asset_id"]}/svg-elements').json()
        assert len(manifest["elements"])==2
        body={"input_asset_id":source["asset_id"],"source_sha256":manifest["source_sha256"],"edits":[
            {"element_id":manifest["elements"][0]["id"],"dx":10,"dy":3},
            {"element_id":manifest["elements"][1]["id"],"deleted":True}]}
        key=uuid4().hex
        response=client.post("/api/v1/jobs/edit-svg",json=body,headers=headers(key))
        assert response.status_code==202,response.text
        assert client.post("/api/v1/jobs/edit-svg",json=body,headers=headers(key)).json()["job_id"]==response.json()["job_id"]
        assert client.post("/api/v1/jobs/edit-svg",json=body).status_code in (403,422)
        job,token=store.claim()
        execute_local(store,job["job_id"],token)
        store.finish_job(job["job_id"],token)
        edited=store.get_job(job["job_id"])["result"]["assets"][0]
        assert store.read_asset(source["asset_id"])[1]==source_bytes
        assert edited["image_id"]==source["image_id"]
        assert edited["license"]=="CC0-1.0"
        assert edited["coordinate_space_id"]==source["coordinate_space_id"]
        assert edited["geometry_verified"] is False and edited["manual_geometry_edit"] is True
        assert edited["parents"]==[{"asset_id":source["asset_id"],"role":"svg_edit_source"}]
        # Reopen through a new store handle, not the in-memory editor manifest.
        reopened=WorkbenchStore(settings.storage_root).read_asset(edited["asset_id"])
        assert len(describe_svg(reopened[1].decode(),(100,100))["elements"])==1
        history=client.get(f'/api/v1/images/{source["image_id"]}/history').json()
        assert edited["asset_id"] in {a["asset_id"] for a in history["items"]}
        archive=run("exports",{"asset_ids":[source["asset_id"],edited["asset_id"]],"layout":"by_image"})
        with zipfile.ZipFile(BytesIO(store.read_asset(archive["asset_id"])[1])) as z:
            saved=json.loads(z.read("manifest.json"))
            assert {a["asset_id"] for a in saved["selected_assets"]}=={source["asset_id"],edited["asset_id"]}
            name=f'images/{source["image_id"]}/svg-{edited["asset_id"]}.svg'
            assert z.read(name)==reopened[1]
