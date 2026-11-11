const typeStyles = {
  task: [215, 'M5 5h14v14H5z M8 12l3 3 5-6'],
  epic: [270, 'M14 2 5 14h6l-1 8 9-13h-6z'],
  bug: [
    350,
    'M8 8h8v9a4 4 0 0 1-8 0z M9 8V5h6v3 M4 10h4 M16 10h4 M4 15h4 M16 15h4 M5 20l3-3 M16 17l3 3',
  ],
  feature: [150, 'm12 3 3 6 6 1-5 5 1 6-5-3-5 3 1-6-5-5 6-1z'],
  chore: [30, 'M14 4a6 6 0 0 0-7 8l-4 5 4 4 5-5a6 6 0 0 0 8-7l-5 4-4-4z'],
  decision: [190, 'm12 3 9 9-9 9-9-9z M9 9l3 3 3-3 M12 12v5'],
  spike: [320, 'M9 3h6 M10 3v7L4 20h16l-6-10V3 M8 15h8'],
  story: [95, 'M6 3h12v18l-6-4-6 4z'],
  milestone: [10, 'M5 22V3 M5 4h14l-4 5 4 5H5'],
  gate: [55, 'M5 5h14v14H5z M10 8v8 M14 8v8'],
};
export function typeHue(type) {
  if (typeStyles[type]) return typeStyles[type][0];
  let n = 0;
  for (const c of String(type)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n % 360;
}
export function typeIcon(type) {
  const path = typeStyles[type]?.[1] || 'M12 3 21 8v8l-9 5-9-5V8z';
  return `<svg class="type-icon" style="--type-hue:${typeHue(type)}" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
