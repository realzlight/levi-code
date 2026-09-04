import React from 'react';
import { render, Box, Text } from 'ink';
import path from 'path';
import terminalImage from 'terminal-image';
import { execaSync } from 'execa';

const h = React.createElement;

const CYAN = '#22d3ee';
const STAR = '#aaaaaa';
const MOON_COLOR = '#e8e8e8';
const CLOUD_COLOR = '#555555';
const BORDER = '#999999';

const WIDTH = 60;
const SKY_HEIGHT = 6;

const MOON = [
  ' ░▓▓▓███░',
  '▓███  ██▓░',
  '███    ░░',
  '███    ░░',
  '▓███  ██▓░',
  ' ░▓████▓░'
];

const CLOUD = [
  '  ▒▒▒▒      ',
  ' ▒▒▒▒▒▒▒▒   ',
  '▒▒▒▒▒▒▒▒▒▒▒▒'
];

const STARS = [
  [0, 4],
  [0, 20],
  [1, 34],
  [2, 12],
  [2, 44],
  [3, 27],
  [4, 2],
  [5, 38],
  [1, 46]
];

function blankCanvas(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      ch: ' ',
      color: null
    }))
  );
}

function stamp(canvas, pattern, row, column, color) {
  pattern.forEach((line, patternRow) => {
    [...line].forEach((character, patternColumn) => {
      const targetRow = row + patternRow;
      const targetColumn = column + patternColumn;

      if (
        character !== ' ' &&
        canvas[targetRow] &&
        canvas[targetRow][targetColumn]
      ) {
        canvas[targetRow][targetColumn] = {
          ch: character,
          color
        };
      }
    });
  });
}

function buildSky() {
  const canvas = blankCanvas(WIDTH, SKY_HEIGHT);

  STARS.forEach(([row, column]) => {
    if (canvas[row] && canvas[row][column]) {
      canvas[row][column] = {
        ch: '*',
        color: STAR
      };
    }
  });

  // Moon: one row below the upper border
  stamp(canvas, MOON, 0, WIDTH - 10, MOON_COLOR);

  // Left cloud
  stamp(canvas, CLOUD, 4, 4, CLOUD_COLOR);

  // Right cloud
  stamp(canvas, CLOUD, 3, 27, CLOUD_COLOR);

  return canvas;
}

function CanvasRow({ cells }) {
  const segments = [];
  let current = null;

  cells.forEach((cell) => {
    if (current && current.color === cell.color) {
      current.text += cell.ch;
    } else {
      if (current) {
        segments.push(current);
      }

      current = {
        text: cell.ch,
        color: cell.color
      };
    }
  });

  if (current) {
    segments.push(current);
  }

  return h(
    Box,
    null,
    segments.map((segment, index) =>
      h(
        Text,
        {
          key: index,
          color: segment.color || undefined
        },
        segment.text
      )
    )
  );
}

function Border() {
  return h(
    Text,
    {
      color: BORDER
    },
    '_'.repeat(WIDTH)
  );
}

function App({ mascot }) {
  const sky = buildSky();

  return h(
    Box,
    {
      flexDirection: 'column',
      width: WIDTH
    },

    // Header
    h(
      Box,
      {
        height: 1
      },
      h(Text, { color: 'white' }, 'Welcome to '),
      h(Text, { color: CYAN, bold: true }, 'Levi Code'),
      h(Text, { color: 'white' }, ' v1')
    ),

    // Space before upper border
    h(Box, { height: 1 }),

    // Upper border
    h(Border),

    // Space between upper border and moon
    h(Box, { height: 1 }),

    // Sky
    h(
      Box,
      {
        flexDirection: 'column',
        height: SKY_HEIGHT
      },
      sky.map((row, index) =>
        h(CanvasRow, {
          key: index,
          cells: row
        })
      )
    ),

    // Space before mascot
//    h(Box, { height: 1 }),

    // Mascot overlaps the lower border by one row
    mascot
      ? h(
          Box,
          {
            flexDirection: 'column',
            marginBottom: -1
          },
          h(Text, null, mascot)
        )
      : null,

    // Lower border
    h(Border)
  );
}

let mascot = '';

try {
  mascot = await terminalImage.file(
    path.join(process.cwd(), 'assets', 'mascot.png'),
    {
      width: 10
    }
  );
} catch {
  mascot = '';
}

execaSync(process.platform === 'win32' ? 'cls' : 'clear', {
  shell: true,
  stdio: 'inherit'
});

render(h(App, { mascot }));
