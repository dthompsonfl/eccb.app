
const sharp = require('sharp');
const TEAL = { r: 15, g: 118, b: 110 };
const TEAL_DARK = { r: 31, g: 41, b: 55 };
// A stylised music-stand glyph: three ascending note bars, like a music stand.
function glyph(size) {
  const s = size;
  const pad = s * 0.18;
  const barW = s * 0.11;
  const gap = s * 0.16;
  const heights = [0.34, 0.52, 0.70];
  const baseY = s - pad;
  let bars = '<rect x="' + pad + '" y="' + (baseY - s*heights[0]) + '" width="' + barW + '" height="' + (s*heights[0]) + '" rx="' + (barW*0.45) + '" fill="#5eead4"/>';
  bars += '<rect x="' + (pad + gap) + '" y="' + (baseY - s*heights[1]) + '" width="' + barW + '" height="' + (s*heights[1]) + '" rx="' + (barW*0.45) + '" fill="#ffffff"/>';
  bars += '<rect x="' + (pad + gap*2) + '" y="' + (baseY - s*heights[2]) + '" width="' + barW + '" height="' + (s*heights[2]) + '" rx="' + (barW*0.45) + '" fill="#5eead4"/>';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s + '" viewBox="0 0 ' + s + ' ' + s + '">'
    + '<rect width="' + s + '" height="' + s + '" rx="' + (s*0.22) + '" fill="rgb(' + TEAL.r + ',' + TEAL.g + ',' + TEAL.b + ')"/>'
    + bars
    + '<rect x="' + (pad*0.6) + '" y="' + (baseY + s*0.05) + '" width="' + (s - pad*1.2) + '" height="' + (s*0.045) + '" rx="' + (s*0.022) + '" fill="#ffffff"/>'
    + '</svg>';
  return sharp(Buffer.from(svg)).png().toFile(process.argv[2] + '/icon-' + size + '.png');
}
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
Promise.all(sizes.map(g => glyph(g))).then(() => console.log('icons written')).catch(e => { console.error(e.message); process.exit(1); });
