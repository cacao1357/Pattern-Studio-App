/* =============================================================================
   icons.js — 单文件图标集合（描边 1.6，24 网格），以 <symbol> 注入一次。
   用法：<svg class="icon"><use href="#i-xxx"></use></svg>
   ============================================================================= */

const ICONS = {
  mark: `<path d="M16 3.5c4.2 4.2 8 8 12.5 12.5C24 20.5 20.2 24.3 16 28.5 11.8 24.3 8 20.5 3.5 16 8 11.5 11.8 7.7 16 3.5Z"/><path d="M16 9.6c2.3 2.3 4.1 4.1 6.4 6.4-2.3 2.3-4.1 4.1-6.4 6.4-2.3-2.3-4.1-4.1-6.4-6.4 2.3-2.3 4.1-4.1 6.4-6.4Z"/><circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none"/>`,
  home: `<path d="M4 10.6 12 4l8 6.6"/><path d="M6.2 9.6V19.4h11.6V9.6"/>`,
  grid: `<rect x="3.6" y="3.6" width="7" height="7"/><rect x="13.4" y="3.6" width="7" height="7"/><rect x="3.6" y="13.4" width="7" height="7"/><rect x="13.4" y="13.4" width="7" height="7"/>`,
  upload: `<path d="M12 15.4V4.6"/><path d="m7.9 8.7 4.1-4.1 4.1 4.1"/><path d="M5 15.6v2.6a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8v-2.6"/>`,
  search: `<circle cx="10.8" cy="10.8" r="6.2"/><path d="m15.4 15.4 4.2 4.2"/>`,
  gear: `<circle cx="12" cy="12" r="3"/><path d="M12 2.9v2.3M12 18.8v2.3M2.9 12h2.3M18.8 12h2.3M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>`,
  image: `<rect x="3.6" y="4.6" width="16.8" height="14.8"/><circle cx="8.8" cy="9.4" r="1.4" fill="currentColor" stroke="none"/><path d="m5.6 17 4.3-4.4 3 2.9 2.5-2.3 3 3.8"/>`,
  check: `<path d="m5 12.6 4.3 4.3L19.4 6.6"/>`,
  alert: `<path d="M12 4.3 20.8 19.7H3.2L12 4.3Z"/><path d="M12 9.6v4.6M12 17v.2"/>`,
  arrow: `<path d="M4.6 12h14.8"/><path d="m14 6.6 5.4 5.4L14 17.4"/>`,
  chevron: `<path d="m7.2 9.6 4.8 4.8 4.8-4.8"/>`,
  chevronLeft: `<path d="m14.4 6.6-5.4 5.4 5.4 5.4"/>`,
  close: `<path d="m6 6 12 12M18 6 6 18"/>`,
  crop: `<path d="M7.2 3.4V17h13.4"/><path d="M16.8 20.6V7H3.4"/>`,
  brush: `<path d="M14.6 4.3 19.7 9.4 10 19.1H4.9v-5.1L14.6 4.3Z"/><path d="m12.7 6.2 5.1 5.1M4.9 19.1 8 16"/>`,
  layers: `<path d="m12 3.6 8.4 4.6L12 12.8 3.6 8.2 12 3.6Z"/><path d="m3.6 12.6 8.4 4.6 8.4-4.6"/><path d="m3.6 16.9 8.4 4.6 8.4-4.6"/>`,
  spark: `<path d="M12 3.6c.5 4.5 2 6 6.4 6.4-4.4.5-5.9 2-6.4 6.4-.5-4.4-2-5.9-6.4-6.4 4.4-.4 5.9-1.9 6.4-6.4Z"/><path d="M18.2 15.2c.2 1.9.9 2.6 2.8 2.8-1.9.2-2.6.9-2.8 2.8-.2-1.9-.9-2.6-2.8-2.8 1.9-.2 2.6-.9 2.8-2.8Z"/>`,
  eye: `<path d="M3.6 12s3.1-5.1 8.4-5.1S20.4 12 20.4 12s-3.1 5.1-8.4 5.1S3.6 12 3.6 12Z"/><circle cx="12" cy="12" r="2.3"/>`,
  download: `<path d="M12 4.6v10.8"/><path d="m7.9 11.3 4.1 4.1 4.1-4.1"/><path d="M5 16.6v1.8a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8v-1.8"/>`,
  history: `<path d="M4.4 9.4A8.2 8.2 0 1 1 4.2 14"/><path d="M4.2 5.3v4.2h4.2"/><path d="M12 8v4.2l2.9 1.8"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  minus: `<path d="M5 12h14"/>`,
  fit: `<path d="M4.4 9V4.4h4.6M19.6 9V4.4H15M4.4 15v4.6h4.6M19.6 15v4.6H15"/>`,
  compare: `<path d="M12 3.6v16.8"/><path d="M8.4 7.4H4.2v9.2h4.2"/><path d="M15.6 7.4h4.2v9.2h-4.2"/>`,
  undo: `<path d="M4.6 9.2h9.2a5.4 5.4 0 0 1 0 10.8H8"/><path d="m8.4 5-3.8 4.2L8.4 13"/>`,
  redo: `<path d="M19.4 9.2H10.2a5.4 5.4 0 0 0 0 10.8H16"/><path d="m15.6 5 3.8 4.2L15.6 13"/>`,
  lock: `<rect x="5" y="10.2" width="14" height="9.8"/><path d="M8.6 10.2V7.9a3.4 3.4 0 0 1 6.8 0v2.3"/>`,
  flask: `<path d="M9.6 3.6v6L4.8 18a2.2 2.2 0 0 0 1.9 3.2h10.6a2.2 2.2 0 0 0 1.9-3.2l-4.8-8.4v-6"/><path d="M8.2 3.6h7.6"/>`,
  file: `<path d="M6 3.6h7.4L19 9.2v11.2H6V3.6Z"/><path d="M13.2 3.6v5.8h5.8"/>`,
  tile: `<rect x="3.6" y="3.6" width="7.2" height="7.2"/><rect x="13.2" y="3.6" width="7.2" height="7.2"/><rect x="3.6" y="13.2" width="7.2" height="7.2"/><rect x="13.2" y="13.2" width="7.2" height="7.2"/>`,
  mask: `<circle cx="12" cy="12" r="8.4"/><path d="M12 3.6v16.8" stroke-dasharray="2 2.4"/>`,
  text: `<path d="M5 6.4V4.6h14v1.8"/><path d="M12 4.6v14.8"/><path d="M8.6 19.4h6.8"/>`,
  info: `<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5.4M12 7.8v.2"/>`,
  folder: `<path d="M3.6 6.6h6l1.8 2.4h9v10.4H3.6V6.6Z"/>`,
  star: `<path d="m12 4 2.4 5 5.4.7-4 3.7 1 5.3-4.8-2.7-4.8 2.7 1-5.3-4-3.7 5.4-.7L12 4Z"/>`,
  drag: `<path d="M8.4 6h7.2M8.4 12h7.2M8.4 18h7.2"/>`,
  play: `<path d="M8 5.4v13.2L19 12 8 5.4Z"/>`,
  cloud: `<path d="M7.4 18.4a4.2 4.2 0 0 1-.5-8.4 5.4 5.4 0 0 1 10.4-1.2 3.8 3.8 0 0 1 .3 7.6"/>`,
  cpu: `<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="1.6"/><rect x="9.6" y="9.6" width="4.8" height="4.8" rx=".8"/><path d="M9.4 3v3.4M14.6 3v3.4M9.4 17.6V21M14.6 17.6V21M3 9.4h3.4M3 14.6h3.4M17.6 9.4H21M17.6 14.6H21"/>`,
  sliders: `<path d="M5 7.2h14M5 16.8h14"/><circle cx="9.4" cy="7.2" r="2.2"/><circle cx="15" cy="16.8" r="2.2"/>`,
  external: `<path d="M13.4 4.6h6v6"/><path d="M19 5 11 13"/><path d="M18 13.6v4.2a1.8 1.8 0 0 1-1.8 1.8H6.2a1.8 1.8 0 0 1-1.8-1.8V8.2a1.8 1.8 0 0 1 1.8-1.8h4.2"/>`,
  palette: `<path d="M12 3.6a8.4 8.4 0 0 0 0 16.8c1.4 0 1.9-1 1.9-1.9 0-1.9 1.4-2.3 2.6-2.3h1.6a2.3 2.3 0 0 0 2.3-2.3A8.4 8.4 0 0 0 12 3.6Z"/><circle cx="8.2" cy="9.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="7.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.6" cy="9.4" r="1.1" fill="currentColor" stroke="none"/>`,
  scan: `<path d="M4 8.2V4.4h3.8M19.8 8.2V4.4H16M4 15.8v3.8h3.8M19.8 15.8v3.8H16"/><path d="M4 12h15.8"/>`,
  gallery: `<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="1.4"/><path d="m3.6 15.4 4.8-4.6 4 3.8 3.2-3 4.6 4.2"/>`,
  list: `<path d="M4.4 6.6h15.2M4.4 12h15.2M4.4 17.4h15.2"/>`,
  seal: `<rect x="4.4" y="4.4" width="15.2" height="15.2" rx="1.6"/><path d="M8.6 9.2h6.8M8.6 12h6.8M8.6 14.8h4.2"/>`,
};

export function injectIcons() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  for (const [name, body] of Object.entries(ICONS)) {
    const symbol = document.createElementNS(ns, "symbol");
    symbol.setAttribute("id", `i-${name}`);
    symbol.setAttribute("viewBox", name === "mark" ? "0 0 32 32" : "0 0 24 24");
    symbol.setAttribute("fill", "none");
    symbol.setAttribute("stroke", "currentColor");
    symbol.setAttribute("stroke-width", name === "mark" ? "1.5" : "1.6");
    symbol.setAttribute("stroke-linecap", "round");
    symbol.setAttribute("stroke-linejoin", "round");
    symbol.innerHTML = body;
    svg.append(symbol);
  }
  document.body.prepend(svg);
}

export function icon(name, cls = "icon") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}
