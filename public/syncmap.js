// Build a lookup between source lines and PDF rows from SyncTeX records
// [page, line, x, y, w, h, d]. Each row (page + baseline) is owned by the source
// line with the most small records on it; full-width line boxes are tagged with the
// following line by TeX, so they're ignored.
export function buildSyncMap(records, firstLine, lastLine) {
  const rows = new Map();
  for (const [page, line, x, y, w] of records) {
    if (line <= firstLine || line >= lastLine || w > 300) continue;
    const key = `${page}:${Math.round(y * 2) / 2}`;
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { page, y, recs: [] }));
    row.recs.push({ line, x, w });
  }
  const list = [];
  for (const row of rows.values()) {
    const counts = new Map();
    for (const r of row.recs) counts.set(r.line, (counts.get(r.line) || 0) + 1);
    // Structural lines (\begin{center}, \item) can narrowly outnumber the text line on
    // the same row; among close contenders the later line is the one with the text.
    const max = Math.max(...counts.values());
    row.line = Math.max(...[...counts].filter(([, c]) => c >= max / 2).map(([l]) => l));
    const own = row.recs.filter((r) => r.line === row.line);
    row.left = Math.min(...own.map((r) => r.x));
    row.right = Math.max(...own.map((r) => r.x + r.w));
    list.push(row);
  }
  return list;
}

// PDF point (in points from the page's top-left) -> source line.
export function lineAtPoint(map, page, X, Y) {
  let best = null;
  let bestScore = Infinity;
  for (const row of map) {
    if (row.page !== page) continue;
    const dy = Y > row.y + 3 ? Y - row.y - 3 : Y < row.y - 9 ? row.y - 9 - Y : 0;
    const dx = X < row.left ? row.left - X : X > row.right ? X - row.right : 0;
    // Row bands overlap, so also prefer the row whose text center (about 3pt above
    // the baseline) is nearest the click.
    const score = dy * 4 + dx * 0.2 + Math.abs(Y - (row.y - 3)) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = row.line;
    }
  }
  return best;
}

// Source line -> box on the PDF, trying nearby lines when this one produced no text
// (macro arguments are attributed to the last line of the macro call).
export function boxForLine(map, line) {
  for (const L of [line, line + 1, line + 2, line + 3, line - 1, line - 2, line - 3]) {
    const rows = map.filter((r) => r.line === L);
    if (!rows.length) continue;
    const page = rows[0].page;
    const onPage = rows.filter((r) => r.page === page);
    return {
      page,
      line: L,
      left: Math.min(...onPage.map((r) => r.left)),
      right: Math.max(...onPage.map((r) => r.right)),
      top: Math.min(...onPage.map((r) => r.y)) - 9,
      bottom: Math.max(...onPage.map((r) => r.y)) + 3,
    };
  }
  return null;
}
