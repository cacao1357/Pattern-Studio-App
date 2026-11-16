"""Bounded visual-component editing of generated SVGs; never retrace curves.

Sampled geometry determines ownership only. The original curve commands remain
in the exported SVG. Ambiguous/self-intersecting shapes fail explicitly rather
than silently detaching a hole or converting curves to a polygonal outline.
"""
from copy import deepcopy
from hashlib import sha256
import math
import re
import time
import xml.etree.ElementTree as ET

from shapely.geometry import Polygon, LineString
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree
from shapely.errors import GEOSException
from svg.path import parse_path, Move, Close, Line

from app.services.vector import validate_svg, SVG_NS
from app.storage import ServiceError

VERSION = "svg-visual-elements-v1"
MAX_SEGMENTS = 100000
MAX_RINGS = 10000
MAX_POINTS = 250000
MAX_ELEMENTS = 10000


def _unsupported(message):
    raise ServiceError("SVG_EDIT_UNSUPPORTED", message, 422)


class Budget:
    def __init__(self):
        self.points = self.segments = self.rings = 0
        self.deadline = time.monotonic() + 8

    def check(self):
        if (self.points > MAX_POINTS or self.segments > MAX_SEGMENTS or
                self.rings > MAX_RINGS or time.monotonic() > self.deadline):
            raise ServiceError("SVG_EDIT_COMPLEXITY", "SVG is too complex for safe interactive component editing", 422)


def _translation(value):
    if not value:
        return 0.0, 0.0
    match = re.fullmatch(r"translate\(\s*([+\-\d.eE]+)(?:[\s,]+([+\-\d.eE]+))?\s*\)", value)
    if not match:
        _unsupported("Only generated translation transforms can be edited")
    try:
        values = float(match[1]), float(match[2] or 0)
    except ValueError:
        _unsupported("Invalid SVG translation")
    if not all(math.isfinite(v) and abs(v) <= 1e6 for v in values):
        _unsupported("SVG translation exceeds the supported coordinates")
    return values


def _sample(segment, budget):
    if isinstance(segment, (Line, Close)):
        budget.points += 1
        budget.check()
        return [segment.end]
    result = []

    def visit(a, b, pa, pb, depth):
        # Quarter points catch symmetric cubic curves whose midpoint is on the chord.
        points = [segment.point(a + (b-a)*fraction) for fraction in (.25, .5, .75)]
        chord = pb-pa
        def deviation(p):
            if abs(chord) < 1e-12:
                return abs(p-pa)
            fraction = max(0.0, min(1.0, ((p-pa).real*chord.real + (p-pa).imag*chord.imag) / abs(chord)**2))
            return abs(p - (pa + fraction*chord))
        error = max(deviation(p) for p in points)
        if error <= .02:
            result.append(pb)
            budget.points += 1
            budget.check()
        elif depth >= 12:
            _unsupported("Curve cannot be safely classified at the editor tolerance")
        else:
            middle = (a+b)/2
            visit(a, middle, pa, points[1], depth+1)
            visit(middle, b, points[1], pb, depth+1)

    visit(0, 1, segment.start, segment.end, 0)
    return result


def _rings(d, budget):
    if len(d) > 1_000_000 or len(re.findall(r"[MmLlHhVvCcSsQqTtAaZz]", re.sub(r"[eE][+-]?\d+", "", d))) > MAX_SEGMENTS:
        raise ServiceError("SVG_EDIT_COMPLEXITY", "SVG path exceeds the interactive parser limit", 422)
    try:
        parsed = parse_path(d)
    except (ValueError, AssertionError, IndexError, ZeroDivisionError, OverflowError):
        _unsupported("SVG path syntax is not supported")
    budget.segments += len(parsed)
    budget.check()
    chunks, chunk = [], []
    for segment in parsed:
        if isinstance(segment, Move):
            if chunk:
                chunks.append(chunk)
            chunk = [segment]
        else:
            chunk.append(segment)
    if chunk:
        chunks.append(chunk)
    raw_chunks = re.findall(r"[Mm][^Mm]*", d)
    if len(raw_chunks) != len(chunks):
        _unsupported("SVG subpath boundaries cannot be recovered safely")
    result = []
    for chunk, raw in zip(chunks, raw_chunks):
        if not chunk or not isinstance(chunk[0], Move) or len(chunk) < 2:
            continue
        budget.rings += 1
        budget.check()
        chunk = deepcopy(chunk)
        # Standalone relative moveto must use its resolved position, not the
        # previous subpath's cursor (which may belong to another component).
        chunk[0].relative = False
        points = [chunk[0].end]
        for segment in chunk[1:]:
            points.extend(_sample(segment, budget))
        points.append(points[0])  # SVG fills implicitly close open subpaths.
        if any(not math.isfinite(v) or abs(v) > 1e6 for p in points for v in (p.real, p.imag)):
            _unsupported("SVG path contains unsupported coordinates")
        coords = [(p.real, p.imag) for p in points]
        polygon = Polygon(coords)
        if polygon.is_empty or len(set(coords)) < 3:
            _unsupported("Degenerate subpath needs manual review")
        signed = sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(coords, coords[1:]))
        if raw.startswith("m"):
            number = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
            move = re.match(r"m\s*("+number+r")[\s,]*("+number+r")", raw)
            if not move:
                _unsupported("Cannot resolve relative SVG moveto")
            tail = raw[move.end():].lstrip(" ,\t\r\n")
            # Additional pairs following m are implicit relative lineto.
            if tail and (tail[0].isdigit() or tail[0] in ".+-"):
                tail = "l " + tail
            raw = f"M{chunk[0].end.real:.17g},{chunk[0].end.imag:.17g} " + tail
        result.append((raw, polygon, 1 if signed > 0 else -1))
    return result


def _components(rings, rule, budget):
    if not rings:
        return []
    polygons = [ring[1] for ring in rings]
    tree = STRtree(polygons)
    if len(rings) == 1 and polygons[0].is_valid:
        return [(rings[0][0], polygons[0].bounds)]
    if rule == "nonzero" and len({ring[2] for ring in rings}) == 1 and all(p.is_valid for p in polygons):
        # Exact pixel rectangles often number in the thousands. Equal winding
        # means their union is the fill, avoiding an O(rings*faces) overlay.
        geometry = unary_union(polygons)
    else:
        linework = unary_union([LineString(p.exterior.coords) for p in polygons])
        budget.check()
        faces = list(polygonize(linework))
        if len(faces) > MAX_POINTS:
            raise ServiceError("SVG_EDIT_COMPLEXITY", "Too many intersecting SVG regions", 422)
        filled = []
        for face in faces:
            budget.check()
            point = face.representative_point()
            winding = 0
            for index in tree.query(point):
                index = int(index)
                polygon = polygons[index]
                if polygon.is_valid:
                    if polygon.covers(point):
                        winding += rings[index][2]
                else:
                    # Sampled tracer loops can cross. Classify faces using the
                    # SVG winding rule rather than repairing/changing curves.
                    x,y = point.x,point.y
                    coords = list(polygon.exterior.coords)
                    for (ax,ay),(bx,by) in zip(coords,coords[1:]):
                        side = (bx-ax)*(y-ay)-(x-ax)*(by-ay)
                        if ay <= y < by and side > 0:
                            winding += 1
                        elif by <= y < ay and side < 0:
                            winding -= 1
            if (winding % 2) if rule == "evenodd" else (winding != 0):
                filled.append(face)
        geometry = unary_union(filled)
    if geometry.is_empty:
        _unsupported("Subpaths cancel completely under their fill rule")
    parts = [geometry] if geometry.geom_type == "Polygon" else list(geometry.geoms)
    # Point-touching polygon parts belong to the same visible region too.
    parent = list(range(len(parts)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    part_tree = STRtree(parts)
    for i, part in enumerate(parts):
        for j in part_tree.query(part):
            j = int(j)
            if j > i and part.intersects(parts[j]):
                parent[find(j)] = find(i)
    groups = {}
    for i, part in enumerate(parts):
        groups.setdefault(find(i), []).append(part)
    regions = [unary_union(group) for group in groups.values()]
    region_tree = STRtree(regions)
    paths = [[] for _ in regions]
    first_ring = [len(rings)] * len(regions)
    for ring_index, (d, polygon, _) in enumerate(rings):
        budget.check()
        boundary = polygon.boundary
        owners = [int(i) for i in region_tree.query(boundary) if regions[int(i)].intersects(boundary)]
        if len(owners) != 1:
            _unsupported("A subpath spans multiple visual regions; cannot safely detach holes")
        paths[owners[0]].append(d)
        first_ring[owners[0]] = min(first_ring[owners[0]], ring_index)
    return [(" ".join(paths[i]), regions[i].bounds) for i in sorted(range(len(regions)), key=lambda i: first_ring[i]) if paths[i]]


def _describe_svg(svg, size):
    validate_svg(svg, size, allow_empty=True)
    root = ET.fromstring(svg)
    elements, budget = [], Budget()
    path_index = 0

    def walk(node, dx=0.0, dy=0.0, fill="#000000", rule="nonzero"):
        nonlocal path_index
        tx, ty = _translation(node.get("transform"))
        dx, dy = dx+tx, dy+ty
        fill, rule = node.get("fill", fill), node.get("fill-rule", rule)
        if rule not in {"evenodd", "nonzero"}:
            _unsupported("Unsupported fill rule")
        if node.tag == f"{{{SVG_NS}}}path":
            index = path_index
            path_index += 1
            if fill == "none":
                _unsupported("Invisible paths cannot be safely edited")
            for component, (d, bounds) in enumerate(_components(_rings(node.get("d", ""), budget), rule, budget)):
                if len(elements) >= MAX_ELEMENTS:
                    raise ServiceError("SVG_EDIT_COMPLEXITY", "Too many visual elements", 422)
                elements.append({"id": f"p{index}c{component}", "d": d, "fill": fill,
                                 "fill_rule": rule, "transform": f"translate({dx:.17g},{dy:.17g})",
                                 "bbox": [bounds[0]+dx, bounds[1]+dy, bounds[2]+dx, bounds[3]+dy]})
        else:
            for child in node:
                walk(child, dx, dy, fill, rule)
    walk(root)
    return {"version": VERSION, "width": size[0], "height": size[1], "elements": elements,
            "source_sha256": sha256(svg.encode("utf-8")).hexdigest()}


def describe_svg(svg, size):
    try:
        return _describe_svg(svg, size)
    except GEOSException:
        _unsupported("SVG regions could not be classified safely; the source file is unchanged")


def read_elements(store, asset_id):
    source, data = store.read_asset(str(asset_id))
    if source["kind"] != "svg":
        raise ServiceError("SVG_INPUT_REQUIRED", "Choose a saved SVG version", 422)
    return {**describe_svg(data.decode("utf-8"), (source["width"], source["height"])), "asset_id": source["asset_id"]}


def apply_edits(description, edits, source_sha256):
    if source_sha256 != description["source_sha256"]:
        raise ServiceError("SVG_EDIT_SOURCE_MISMATCH", "Reload the selected SVG before saving", 409)
    known = {element["id"] for element in description["elements"]}
    if any(edit.element_id not in known for edit in edits):
        raise ServiceError("SVG_ELEMENT_NOT_FOUND", "Selected element does not belong to this SVG", 422)
    mapping = {edit.element_id: edit for edit in edits}
    width, height = description["width"], description["height"]
    root = ET.Element(f"{{{SVG_NS}}}svg", width=str(width), height=str(height), viewBox=f"0 0 {width} {height}")
    groups = {}
    for element in description["elements"]:
        edit = mapping.get(element["id"])
        if edit and edit.deleted:
            continue
        tx, ty = _translation(element["transform"])
        if edit:
            tx, ty = tx+edit.dx, ty+edit.dy
        transform = f"translate({tx:.17g},{ty:.17g})"
        key = (element["id"].split("c")[0], transform, element["fill"], element["fill_rule"])
        groups.setdefault(key, []).append(element["d"])
    # Drawing separated paths changes subpixel coverage where antialiased
    # edges share a pixel. Keep same-source/same-transform components in one
    # paint operation; element hit regions remain independent in the editor.
    for (_, transform, fill, rule), paths in groups.items():
        ET.SubElement(root, f"{{{SVG_NS}}}path", {"d": " ".join(paths), "fill": fill,
                      "fill-rule": rule, "transform": transform})
    svg = ET.tostring(root, encoding="unicode")
    return svg, validate_svg(svg, (width, height), allow_empty=True)
