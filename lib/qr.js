// Byte-mode QR, ECC level L, mask 0. Scanners accept mask 0 when the format bits match.

const ECC_L = {
  1: { data: 19, ecc: 7, blocks: [[1, 19]] },
  2: { data: 34, ecc: 10, blocks: [[1, 34]] },
  3: { data: 55, ecc: 15, blocks: [[1, 55]] },
  4: { data: 80, ecc: 20, blocks: [[1, 80]] },
  5: { data: 108, ecc: 26, blocks: [[1, 108]] },
  6: { data: 136, ecc: 18, blocks: [[2, 68]] },
  7: { data: 156, ecc: 20, blocks: [[2, 78]] },
  8: { data: 194, ecc: 24, blocks: [[2, 97]] },
  9: { data: 232, ecc: 30, blocks: [[2, 116]] },
  10: { data: 274, ecc: 18, blocks: [[2, 68], [2, 69]] }
};

const ALIGN = {
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
};

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initField() {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
})();

function mul(left, right) {
  if (!left || !right) return 0;
  return EXP[LOG[left] + LOG[right]];
}

function multiplyPoly(left, right) {
  const out = new Array(left.length + right.length - 1).fill(0);
  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) out[i + j] ^= mul(left[i], right[j]);
  }
  return out;
}

function generator(degree) {
  let poly = [1];
  for (let index = 0; index < degree; index += 1) poly = multiplyPoly(poly, [1, EXP[index]]);
  return poly;
}

function reedSolomon(data, degree) {
  const gen = generator(degree);
  const buffer = data.concat(new Array(degree).fill(0));
  for (let index = 0; index < data.length; index += 1) {
    const factor = buffer[index];
    if (!factor) continue;
    for (let term = 0; term < gen.length; term += 1) buffer[index + term] ^= mul(gen[term], factor);
  }
  return buffer.slice(data.length);
}

function bitsFromBytes(bytes) {
  const bits = [];
  for (const value of bytes) {
    for (let shift = 7; shift >= 0; shift -= 1) bits.push((value >> shift) & 1);
  }
  return bits;
}

function pushBits(bits, value, length) {
  for (let shift = length - 1; shift >= 0; shift -= 1) bits.push((value >> shift) & 1);
}

function dataCodewords(text, version) {
  const bytes = Buffer.from(text, 'utf8');
  const capacity = ECC_L[version].data;
  const bits = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, version < 10 ? 8 : 16);
  for (const value of bytes) pushBits(bits, value, 8);
  const capacityBits = capacity * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let index = 0; index < terminator; index += 1) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const pad = [0xec, 0x11];
  let padIndex = 0;
  while (bits.length < capacityBits) {
    pushBits(bits, pad[padIndex % 2], 8);
    padIndex += 1;
  }
  const out = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let shift = 0; shift < 8; shift += 1) value = (value << 1) | bits[index + shift];
    out.push(value);
  }
  return out;
}

function interleave(version, data) {
  const spec = ECC_L[version];
  const groups = [];
  let offset = 0;
  for (const [count, length] of spec.blocks) {
    for (let index = 0; index < count; index += 1) {
      const block = data.slice(offset, offset + length);
      offset += length;
      groups.push({ data: block, ecc: reedSolomon(block, spec.ecc) });
    }
  }
  const out = [];
  const longest = Math.max(...groups.map(group => group.data.length));
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) if (index < group.data.length) out.push(group.data[index]);
  }
  for (let index = 0; index < spec.ecc; index += 1) {
    for (const group of groups) out.push(group.ecc[index]);
  }
  return out;
}

function blank(size) {
  return {
    modules: Array.from({ length: size }, () => new Array(size).fill(0)),
    reserved: Array.from({ length: size }, () => new Array(size).fill(false))
  };
}

function mark(grid, row, col, dark) {
  if (row < 0 || col < 0 || row >= grid.modules.length || col >= grid.modules.length) return;
  grid.modules[row][col] = dark ? 1 : 0;
  grid.reserved[row][col] = true;
}

function finder(grid, row, col) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const on = y >= 0 && y <= 6 && x >= 0 && x <= 6 && (y === 0 || y === 6 || x === 0 || x === 6 || (y >= 2 && y <= 4 && x >= 2 && x <= 4));
      mark(grid, row + y, col + x, on);
    }
  }
}

function alignment(grid, center) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const on = Math.max(Math.abs(x), Math.abs(y)) !== 1;
      mark(grid, center + y, center + x, on);
    }
  }
}

function reserveFormat(grid) {
  const size = grid.modules.length;
  for (let index = 0; index < 9; index += 1) {
    mark(grid, 8, index, false);
    mark(grid, index, 8, false);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(grid, 8, size - 1 - index, false);
    mark(grid, size - 1 - index, 8, false);
  }
  mark(grid, 8, 8, false);
}

function paintFunctionPatterns(version) {
  const size = 21 + (version - 1) * 4;
  const grid = blank(size);
  finder(grid, 0, 0);
  finder(grid, 0, size - 7);
  finder(grid, size - 7, 0);
  for (let index = 8; index < size - 8; index += 1) {
    mark(grid, 6, index, index % 2 === 0);
    mark(grid, index, 6, index % 2 === 0);
  }
  const centers = ALIGN[version] || [];
  for (const row of centers) {
    for (const col of centers) {
      if ((row < 9 && col < 9) || (row < 9 && col > size - 10) || (row > size - 10 && col < 9)) continue;
      alignment(grid, row, col);
    }
  }
  mark(grid, size - 8, 8, true);
  reserveFormat(grid);
  return grid;
}

function placeData(grid, bytes) {
  const bits = bitsFromBytes(bytes);
  const size = grid.modules.length;
  let cursor = 0;
  let right = size - 1;
  while (right > 0) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < size; vert += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (grid.reserved[row][col]) continue;
        const bit = cursor < bits.length ? bits[cursor] : 0;
        cursor += 1;
        grid.modules[row][col] = bit;
      }
    }
    right -= 2;
  }
}

function formatValue() {
  // Error level L is 1 in the QR numbering. Mask is fixed at 0.
  let data = (1 << 3) | 0;
  let rem = data;
  for (let index = 0; index < 10; index += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function formatBits() {
  const value = formatValue();
  const bits = [];
  for (let index = 14; index >= 0; index -= 1) bits.push((value >>> index) & 1);
  return bits;
}

function paintFormat(grid) {
  const bits = formatValue();
  const size = grid.modules.length;
  const bit = (index) => (bits >>> index) & 1;
  for (let index = 0; index <= 5; index += 1) grid.modules[8][index] = bit(index);
  grid.modules[8][7] = bit(6);
  grid.modules[8][8] = bit(7);
  grid.modules[7][8] = bit(8);
  for (let index = 9; index < 15; index += 1) grid.modules[14 - index][8] = bit(index);
  for (let index = 0; index < 8; index += 1) grid.modules[size - 1 - index][8] = bit(index);
  for (let index = 8; index < 15; index += 1) grid.modules[8][size - 15 + index] = bit(index);
  grid.modules[size - 8][8] = 1;
}

function chooseVersion(text) {
  const length = Buffer.byteLength(text, 'utf8');
  for (let version = 1; version <= 10; version += 1) {
    const countBits = version < 10 ? 8 : 16;
    const needed = 4 + countBits + length * 8;
    if (Math.ceil(needed / 8) <= ECC_L[version].data) return version;
  }
  return 0;
}

function encodeQr(text) {
  const version = chooseVersion(text);
  if (!version) throw new Error('QR verisi çok uzun');
  const grid = paintFunctionPatterns(version);
  const data = dataCodewords(text, version);
  const stream = interleave(version, data);
  placeData(grid, stream);
  paintFormat(grid);
  return grid.modules;
}

function qrSvg(text) {
  const modules = encodeQr(text);
  const size = modules.length;
  const quiet = 2;
  const cells = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!modules[row][col]) continue;
      cells.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1"/>`);
    }
  }
  const span = size + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img"><rect width="100%" height="100%" fill="#fff"/>${cells.join('')}</svg>`;
}

module.exports = { encodeQr, qrSvg, formatBits };
