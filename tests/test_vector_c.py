"""C's independent vector contract and geometry regression tests."""
import xml.etree.ElementTree as ET

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.schemas.contracts import VectorOptions, ProcessingError, ResourceLimits
from app.services.vector import vectorize, SVG_NS
from app.services.svg_edit import recolor_svg
from app.versions import VECTOR_VERSION, snapshot


@pytest.mark.parametrize('mode', ['monochrome', 'color'])
@pytest.mark.parametrize('detail', ['low', 'medium', 'high'])
def test_single_pixel_is_real_editable_geometry(mode, detail):
    image = Image.new('RGBA', (19, 13))
    image.putpixel((7, 9), (190, 40, 20, 255))
    result = vectorize(image, VectorOptions(mode=mode, detail=detail))
    assert 'M7 9h1v1h-1Z' in result.svg
    assert result.metadata['small_component_pixels_preserved'] == 1
    assert result.metadata['adapter_version'] == VECTOR_VERSION == snapshot()['vector']
    root = ET.fromstring(result.svg)
    assert root.get('viewBox') == '0 0 19 13'
    assert all(node.tag in {f'{{{SVG_NS}}}svg', f'{{{SVG_NS}}}path'} for node in root.iter())


def test_hidden_rgb_and_alpha_boundary_do_not_pollute_palette():
    pixels = np.random.default_rng(3).integers(0, 256, (24, 25, 4), dtype=np.uint8)
    pixels[:, :, 3] = 127
    pixels[3:15, 4:18] = (20, 30, 40, 128)
    a = vectorize(Image.fromarray(pixels))
    pixels[pixels[:, :, 3] < 128] = (255, 0, 255, 0)
    b = vectorize(Image.fromarray(pixels))
    assert a.svg == b.svg
    assert a.metadata['selected_palette'] == ['#141E28']
    assert a.metadata['alpha_threshold'] == 128


@pytest.mark.parametrize('colors', [2, 4, 8, 16])
def test_palette_budget_and_recolor_keep_geometry(colors):
    pixels = np.random.default_rng(4).integers(0, 256, (20, 20, 4), dtype=np.uint8)
    pixels[:, :, 3] = 255
    result = vectorize(Image.fromarray(pixels), VectorOptions(max_colors=colors))
    assert len(result.metadata['svg_fill_colors']) <= colors
    old = ET.fromstring(result.svg)
    source = result.metadata['svg_fill_colors'][0]
    edited, _ = recolor_svg(result.svg, (20, 20), {source: '#123456'})
    new = ET.fromstring(edited)
    assert [(n.tag, {k:v for k,v in n.attrib.items() if k!='fill'}) for n in old.iter()] == [
        (n.tag, {k:v for k,v in n.attrib.items() if k!='fill'}) for n in new.iter()]


def test_micro_elements_obey_output_limits():
    image = Image.new('RGBA', (20, 20))
    d = ImageDraw.Draw(image)
    for y in range(0, 20, 2):
        for x in range(0, 20, 2):
            d.point((x,y), fill='black')
    with pytest.raises(ProcessingError, match='byte limit'):
        vectorize(image, limits=ResourceLimits(max_svg_bytes=300))


def test_empty_alpha_rejected():
    with pytest.raises(ProcessingError) as error:
        vectorize(Image.new('RGBA', (20,20), (255,0,0,127)))
    assert error.value.code == 'EMPTY_MASK'


@pytest.mark.parametrize('detail', ['low', 'medium', 'high'])
def test_single_pixel_hole_is_preserved(detail):
    image = Image.new('RGBA', (12,12), '#244668')
    image.putpixel((5,5), (0,0,0,0))
    result = vectorize(image, VectorOptions(detail=detail))
    assert result.metadata['singleton_holes_preserved'] == 1
    # Exact rectangles leave (5,5) uncovered; do not turn it into an opaque patch.
    assert result.metadata['exact_component_pixels'] == 143
    assert 'M0 0h12v5h-12Z' in result.svg
    assert 'M0 5h5v1h-5Z' in result.svg
    assert 'M6 5h6v1h-6Z' in result.svg
    assert 'M0 6h12v6h-12Z' in result.svg


def test_local_rerun_preview_download_recolor_and_zip(tmp_path):
    from io import BytesIO
    import json
    import zipfile
    from uuid import uuid4
    from unittest.mock import patch
    import httpx
    from fastapi.testclient import TestClient
    from pydantic import SecretStr
    from app.config import Settings
    from app.main import create_app
    from app.worker import LocalWorker
    from app.workbench_store import WorkbenchStore
    from app.services.local_workbench import execute_local
    from app.storage import png_bytes

    settings = Settings(api_token=SecretStr(''), ark_api_key=SecretStr(''), storage_root=tmp_path/'api',
                        paid_calls_enabled=False)
    store = WorkbenchStore(settings.storage_root)
    calls = []
    def forbidden(request):
        calls.append(str(request.url))
        raise AssertionError('Local vector workflow attempted provider traffic')
    def headers():
        return {'X-Pattern-Studio': 'local', 'Idempotency-Key': uuid4().hex}
    with patch.object(LocalWorker, 'start'), patch.object(LocalWorker, 'stop'), TestClient(
        create_app(settings, transport=httpx.MockTransport(forbidden)),
        base_url='http://127.0.0.1:8765', client=('127.0.0.1', 50000)) as client:
        image = Image.new('RGBA', (96, 96))
        d = ImageDraw.Draw(image)
        d.rectangle((10,10,50,50), fill='#204060')
        d.point((80,80), fill='#204060')
        uploaded = client.post('/api/v1/images', files={'file': ('synthetic.png', png_bytes(image), 'image/png')},
            data={'license': 'CC0-1.0', 'source_type': 'synthetic', 'source_name': 'C regression fixture'}, headers=headers())
        assert uploaded.status_code == 201, uploaded.text
        original = uploaded.json()
        source = original['normalized']
        def run(route, body):
            response = client.post('/api/v1/'+route, json=body, headers=headers())
            assert response.status_code == 202, response.text
            job, token = store.claim()
            assert job['job_id'] == response.json()['job_id']
            execute_local(store, job['job_id'], token)
            store.finish_job(job['job_id'], token)
            completed = store.get_job(job['job_id'])
            assert completed['state'] == 'succeeded', completed
            return completed['result']['assets'][0]
        a = run('jobs/vectorize', {'input_asset_id': source['asset_id'], 'detail': 'medium'})
        old_bytes = store.read_asset(a['asset_id'])[1]
        b = run('jobs/vectorize', {'input_asset_id': source['asset_id'], 'detail': 'high', 'max_colors': 2})
        assert a['asset_id'] != b['asset_id']
        assert store.read_asset(a['asset_id'])[1] == old_bytes
        for asset in (a,b):
            assert asset['parents'] == [{'asset_id': source['asset_id'], 'role': 'vector_input'}]
            assert asset['coordinate_space_id'] == source['coordinate_space_id']
            for field in ('image_id','content_id','license','source_type','source_name','provenance_status'):
                assert asset[field] == source[field]
            assert asset['algorithm_version'] == VECTOR_VERSION
            preview = client.get('/api/v1/assets/'+asset['asset_id']+'/preview')
            download = client.get('/api/v1/assets/'+asset['asset_id']+'/download')
            assert preview.status_code == download.status_code == 200
            assert preview.content == download.content
            assert b'<path' in preview.content and b'<image' not in preview.content
        edited = run('jobs/recolor-svg', {'input_asset_id': a['asset_id'], 'mapping': {'#204060':'#D02040'}})
        assert edited['algorithm_version'] == 'safe-svg-palette-v1'
        assert edited['parents'] == [{'asset_id': a['asset_id'], 'role': 'palette_source'}]
        archive = run('exports', {'asset_ids': [a['asset_id'], b['asset_id'], edited['asset_id']]})
        data = client.get('/api/v1/assets/'+archive['asset_id']+'/download').content
        with zipfile.ZipFile(BytesIO(data)) as z:
            manifest = json.loads(z.read('manifest.json'))
            assert manifest['versions']['vector'] == VECTOR_VERSION
            assert manifest['content_ids'] == [source['content_id']]
            assert source['asset_id'] in {x['asset_id'] for x in manifest['referenced_ancestors']}
            assert len(manifest['selected_assets']) == 3
            for asset in (a,b,edited):
                assert z.read(asset['asset_id']+'.svg') == store.read_asset(asset['asset_id'])[1]
        assert calls == []
