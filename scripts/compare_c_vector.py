"""Optional independent raster QA: resvg-py==0.5.0 in ignored tools directory."""
import json
from io import BytesIO
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path('storage/validation/c/tools').resolve()))
import resvg_py
from validate_c_vector import topology, fixtures


def main():
    base = Path('storage/validation/c')
    board = Image.new('RGB', (96*3, 116*len(fixtures())), 'white')
    draw = ImageDraw.Draw(board)
    comparison = []
    for label in ('before', 'after'):
        directory = base / label
        rows = json.loads((directory/'metrics.json').read_text())
        for row in rows:
            if 'error' in row:
                continue
            data = resvg_py.svg_to_bytes(svg_path=str(directory/(row['stem']+'.svg')))
            (directory/(row['stem']+'.render.png')).write_bytes(data)
            rendered = Image.open(BytesIO(data)).convert('RGBA')
            source = Image.open(directory/(row['fixture']+'.png')).convert('RGBA')
            src = np.asarray(source)
            dst = np.asarray(rendered)
            a, b = src[:, :, 3] >= 128, dst[:, :, 3] >= 128
            row['rendered'] = topology(b)
            row['mask_iou'] = float((a & b).sum() / (a | b).sum())
            row['mask_mismatch_pixels'] = int((a != b).sum())
            if label == 'after':
                assert row['rendered']['components'] == row['input']['components'], row['stem']
                assert row['rendered']['holes'] == row['input']['holes'], row['stem']
                assert row['mask_iou'] >= 0.98, row['stem']
            if row['mode'] == 'color':
                row['visible_rgb_mae'] = float(np.abs(src[a & b, :3].astype(float)-dst[a & b, :3]).mean())
            comparison.append({'label': label, **row})
            if row['mode'] == 'color' and row['detail'] == 'medium':
                y = list(fixtures()).index(row['fixture'])*116
                for x, image in ((0, source), ((1 if label == 'before' else 2)*96, rendered)):
                    background = Image.new('RGBA', image.size, '#eeeeee')
                    background.alpha_composite(image)
                    board.paste(background.convert('RGB'), (x,y+20))
                draw.text((0, y), row['fixture'], fill='black')
        (directory/'render-metrics.json').write_text(json.dumps(rows, indent=2), encoding='utf-8')
    board.save(base/'comparison.png')
    (base/'comparison.json').write_text(json.dumps(comparison, indent=2), encoding='utf-8')
    print('fixture | input components/holes | before -> after components/holes | IoU | paths | bytes | ms')
    for row in comparison:
        if row['label'] != 'before' or row['mode'] != 'color' or row['detail'] != 'medium':
            continue
        after = next(r for r in comparison if r['label']=='after' and r['stem']==row['stem'])
        print(row['fixture'], row['input'], row['rendered'], '->', after['rendered'],
              f"IoU {row['mask_iou']:.5f}->{after['mask_iou']:.5f}",
              *[f"{row['metadata'][k]}->{after['metadata'][k]}" for k in ('path_count','svg_bytes')],
              f"ms {row['elapsed_ms']}->{after['elapsed_ms']}")


if __name__ == '__main__':
    main()
