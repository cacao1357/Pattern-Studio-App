"""Deterministic, original synthetic development fixtures (not acceptance images).

Run before/after algorithm changes, then render with compare_c_vector.py.
All generated files stay below ignored storage/validation/c.
"""
import argparse
import json
import subprocess
import sys
import types
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np
from PIL import Image, ImageDraw

from app.schemas.contracts import VectorOptions
from app.services.vector import vectorize


def fixtures():
    result = {}
    for name in ("solid", "thin_holes", "elements", "adjacent_colors", "alpha_hidden", "jagged", "micro_hole"):
        image = Image.new("RGBA", (96, 96))
        d = ImageDraw.Draw(image)
        if name == "solid":
            d.ellipse((12, 12, 83, 83), fill="#244668")
        elif name == "thin_holes":
            d.rectangle((12, 12, 75, 75), fill="#244668")
            d.rectangle((26, 26, 60, 60), fill=(0, 0, 0, 0))
            d.rectangle((65, 20, 66, 21), fill=(0, 0, 0, 0))
            d.line((5, 85, 85, 85), fill="#244668", width=1)
        elif name == "elements":
            d.rectangle((12, 12, 45, 45), fill="#244668")
            for x, y, size in ((60, 12, 1), (65, 20, 2), (70, 30, 3), (80, 50, 4)):
                d.rectangle((x, y, x+size-1, y+size-1), fill="#244668")
        elif name == "adjacent_colors":
            for i, color in enumerate(("#B02030", "#B12131", "#2040B0", "#2141B1")):
                d.rectangle((8+i*20, 8, 27+i*20, 87), fill=color)
        elif name == "alpha_hidden":
            pixels = np.random.default_rng(20261103).integers(0, 256, (96, 96, 4), dtype=np.uint8)
            pixels[:, :, 3] = 0
            image = Image.fromarray(pixels)
            d = ImageDraw.Draw(image)
            for x, alpha in ((10, 0), (20, 127), (30, 128), (40, 200), (50, 255)):
                d.rectangle((x, 10, x+7, 80), fill=(36, 70, 104, alpha))
        elif name == "micro_hole":
            d.rectangle((10,10,85,85), fill="#244668")
            d.point((40,40), fill=(0,0,0,0))
        else:
            points = [(10+i, 15+(i % 2)) for i in range(75)] + [(84, 80), (10, 80)]
            d.polygon(points, fill="#244668")
            for x in range(15, 80, 6):
                d.point((x, 88), fill="#244668")
        result[name] = image
    return result


def topology(mask):
    mask = mask.astype(np.uint8)
    components = cv2.connectedComponents(mask, connectivity=8)[0]-1
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    holes = 0 if hierarchy is None else sum(int(row[3] >= 0) for row in hierarchy[0])
    return {"components": components, "holes": holes, "area": int(mask.sum())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("label")
    parser.add_argument("--baseline-ref", help="Read the trusted adapter from this Git revision; never checks out files")
    args = parser.parse_args()
    adapter = vectorize
    baseline_source = None
    if args.baseline_ref:
        baseline_source = subprocess.check_output(
            ['git', 'show', args.baseline_ref+':backend/app/services/vector.py'], text=True, encoding='utf-8')
        module = types.ModuleType('c_baseline_vector')
        sys.modules[module.__name__] = module
        exec(compile(baseline_source, 'baseline-vector.py', 'exec'), module.__dict__)
        adapter = module.vectorize
    output = Path("storage/validation/c") / args.label
    output.mkdir(parents=True, exist_ok=True)
    if baseline_source:
        (output/'vector-source.py').write_text(baseline_source, encoding='utf-8')
    rows = []
    for name, image in fixtures().items():
        image.save(output / (name + ".png"))
        for mode in ("monochrome", "color"):
            for detail in ("low", "medium", "high"):
                stem = f"{name}-{mode}-{detail}"
                start = perf_counter()
                try:
                    result = adapter(image, VectorOptions(mode=mode, detail=detail))
                    (output / (stem+".svg")).write_text(result.svg, encoding="utf-8")
                    row = {"metadata": result.metadata}
                except ValueError as exc:
                    row = {"error": str(exc)}
                rows.append({"stem": stem, "fixture": name, "mode": mode, "detail": detail,
                             "elapsed_ms": round((perf_counter()-start)*1000, 3),
                             "input": topology(np.asarray(image)[:, :, 3] >= 128), **row})
    (output / "metrics.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
