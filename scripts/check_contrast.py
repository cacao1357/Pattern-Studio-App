"""按 WCAG 2.x 核算配色令牌的对比度。

用法（在仓库根目录执行）：

    python scripts/check_contrast.py                       # 默认检查 frontend/next-v2/css/tokens.css
    python scripts/check_contrast.py path/to/tokens.css

令牌直接从 CSS 里解析，改完配色只要重跑这个脚本，不用手抄色号。
只支持字面量（#rrggbb / rgb[a]()）；color-mix() 之类派生令牌会被跳过。
退出码：全部达标 0，有未达标或缺项 1。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSS = ROOT / "frontend" / "next-v2" / "css" / "tokens.css"

TOKEN_RE = re.compile(
    r"--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))", re.IGNORECASE
)


def parse_tokens(path: Path) -> dict[str, tuple[int, int, int]]:
    tokens: dict[str, tuple[int, int, int]] = {}
    for name, value in TOKEN_RE.findall(path.read_text(encoding="utf-8")):
        if name in tokens:
            continue  # 同一文件里首次出现即生效
        value = value.strip()
        if value.startswith("#"):
            h = value.lstrip("#")
            if len(h) == 3:
                h = "".join(c * 2 for c in h)
            tokens[name] = tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[assignment]
        else:
            parts = re.findall(r"[\d.]+", value)
            if len(parts) < 3:
                continue
            tokens[name] = tuple(int(float(p)) for p in parts[:3])  # type: ignore[assignment]
    return tokens


def srgb_to_lin(channel: float) -> float:
    c = channel / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb: tuple[int, int, int]) -> float:
    r, g, b = (srgb_to_lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# (说明, 前景令牌, 背景令牌, 目标比值)
# 7:1 = 正文理想值；4.5:1 = 正常文字下限；3:1 = 次要/装饰性文字下限
CASES: list[tuple[str, str, str, float]] = [
    ("正文 / 卡面", "text-1", "bg-2", 7.0),
    ("正文 / 最亮面板", "text-1", "bg-4", 7.0),
    ("正文 / 页面底", "text-1", "bg-0", 7.0),
    ("次要文字 / 卡面", "text-2", "bg-2", 4.5),
    ("次要文字 / 最亮面板", "text-2", "bg-4", 4.5),
    ("弱化文字 / 卡面", "text-3", "bg-2", 4.5),
    ("弱化文字 / 最亮面板", "text-3", "bg-4", 4.5),
    ("极弱文字 / 卡面", "text-4", "bg-2", 3.0),
    ("极弱文字 / 最亮面板", "text-4", "bg-4", 3.0),
    ("强调字 / 卡面", "cinnabar", "bg-2", 4.5),
    ("强调字 / 最亮面板", "cinnabar", "bg-4", 4.5),
    ("强调字悬停 / 卡面", "cinnabar-hi", "bg-2", 4.5),
    ("通过（铜绿）/ 卡面", "jade", "bg-2", 4.5),
    ("待办（旧金）/ 卡面", "gold", "bg-2", 4.5),
    ("错误（砖红）/ 卡面", "error", "bg-2", 4.5),
    ("错误（砖红）/ 最亮面板", "error", "bg-4", 4.5),
    ("主按钮文字 / 主按钮", "action-fg", "action-bg", 4.5),
    ("印面文字 / 印底", "on-accent", "cinnabar-deep", 4.5),
    ("纸面正文 / 纸", "paper-ink", "paper-0", 7.0),
    ("纸面弱化 / 纸", "paper-ink-3", "paper-0", 4.5),
    ("纸面弱化 / 纸（深一档）", "paper-ink-3", "paper-1", 4.5),
    ("纸 / 页面底（图版压底）", "paper-0", "bg-0", 7.0),
]


def main(argv: list[str]) -> int:
    css_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_CSS
    if not css_path.is_absolute():
        css_path = (Path.cwd() / css_path).resolve()
    tokens = parse_tokens(css_path)

    print(f"配色文件：{css_path}")
    print(f"解析到 {len(tokens)} 个字面量令牌\n")

    failures = 0
    missing = 0
    for label, fg, bg, target in CASES:
        if fg not in tokens or bg not in tokens:
            print(f"  ??  {label:24s} 缺少令牌 {fg} 或 {bg}")
            missing += 1
            continue
        ratio = contrast(tokens[fg], tokens[bg])
        ok = ratio >= target
        failures += 0 if ok else 1
        print(f"  {'ok ' if ok else 'LOW'} {label:24s} {ratio:5.2f}  (>= {target})")

    print()
    if missing:
        print(f"{missing} 项因缺少令牌未检查")
    if failures:
        print(f"{failures} 项未达标")
        return 1
    print("全部达标")
    return 0 if not missing else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
