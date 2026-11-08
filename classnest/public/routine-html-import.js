/* HTML is parsed only in detached, inert template contents. Imported nodes are
   never attached to the page; callers receive strings and arrays, not markup. */
(() => {
  'use strict';

  const limits = Object.freeze({inputBytes: 256 * 1024, tables: 32, sourceRows: 80, columns: 12, rows: 40, label: 80, cell: 160, bytes: 100 * 1024});
  const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'LINK', 'META', 'BASE', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'CANVAS', 'AUDIO', 'VIDEO']);
  const blockTags = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'UL']);
  const encoder = new TextEncoder();
  const fail = message => { throw new Error(message); };
  const bytes = value => encoder.encode(value).byteLength;

  function readDocument(html) {
    if (typeof html !== 'string' || !html.trim()) fail('Paste HTML containing a table first.');
    // Reject by string length before allocating a UTF-8 representation.
    if (html.length > limits.inputBytes || bytes(html) > limits.inputBytes) fail('The pasted HTML is too large. Use at most 256 KiB.');
    const template = document.createElement('template');
    template.innerHTML = html;
    const tables = Array.from(template.content.querySelectorAll('table')).filter(table => {
      for (let node = table.parentElement; node; node = node.parentElement) {
        if (ignoredTags.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
      }
      return true;
    });
    if (!tables.length) fail('No HTML table was found. Paste a complete <table>…</table>.');
    if (tables.length > limits.tables) fail('There are too many tables. Paste at most 32 tables at a time.');
    return tables;
  }

  function plainText(element) {
    const parts = [];
    // Iterative traversal also handles deeply nested, untrusted markup without
    // overflowing the JavaScript call stack. No attributes are copied.
    const stack = [{node: element, exit: false}];
    while (stack.length) {
      const {node, exit} = stack.pop();
      if (node.nodeType === 3) { parts.push(node.nodeValue); continue; }
      if (node.nodeType !== 1) continue;
      if (node !== element && (ignoredTags.has(node.tagName) || node.tagName === 'TABLE' || node.namespaceURI !== 'http://www.w3.org/1999/xhtml')) continue;
      if (node.tagName === 'BR') { parts.push('\n'); continue; }
      const block = node !== element && blockTags.has(node.tagName);
      if (exit) { if (block) parts.push('\n'); continue; }
      if (block) parts.push('\n');
      if (block) stack.push({node, exit: true});
      for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push({node: node.childNodes[index], exit: false});
    }
    return parts.join('').replace(/\r\n?/g, '\n').replace(/[\t\f\v\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function tableRows(table) {
    return Array.from(table.rows).filter(row => row.closest('table') === table);
  }

  function captionOf(table) {
    return table.caption ? plainText(table.caption) : '';
  }

  function spanValue(cell, name, remaining) {
    const raw = cell.getAttribute(name);
    if (raw === null) return 1;
    const value = raw.trim();
    if (!/^\d+$/.test(value) || value.length > 6) fail('A table cell has an invalid ' + name + '. Use small whole-number spans.');
    const span = Number(value);
    if (name === 'rowspan' && span === 0) return remaining;
    if (!Number.isSafeInteger(span) || span < 1 || span > (name === 'colspan' ? limits.columns : limits.sourceRows)) fail('A table cell has a ' + name + ' that exceeds the routine limits.');
    if (name === 'rowspan' && span > remaining) fail('A rowspan extends past its table section. Include the covered rows or reduce the rowspan.');
    return span;
  }

  function expandTable(table) {
    const source = tableRows(table);
    if (!source.length) fail('The selected table has no rows.');
    if (source.length > limits.sourceRows) fail('The selected table has too many rows. Use at most 40 data rows and a short header.');
    const grid = source.map(() => []);
    let width = 0;
    let merged = false;
    let cellId = 0;
    let cellCount = 0;
    for (let rowIndex = 0; rowIndex < source.length; rowIndex++) {
      const row = source[rowIndex];
      const cells = Array.from(row.cells).filter(cell => cell.parentElement === row);
      if (cells.length > limits.columns) fail('The selected table has more than 12 columns.');
      let groupEnd = rowIndex;
      while (groupEnd + 1 < source.length && source[groupEnd + 1].parentElement === row.parentElement) groupEnd++;
      let column = 0;
      for (const cell of cells) {
        while (grid[rowIndex][column]) column++;
        const across = spanValue(cell, 'colspan', 1);
        const down = spanValue(cell, 'rowspan', groupEnd - rowIndex + 1);
        if (column + across > limits.columns) fail('The selected table expands to more than 12 columns. Reduce its columns or merged cells.');
        const value = {text: plainText(cell), id: cellId++};
        if (value.text.length > limits.cell) fail('A table cell contains more than 160 characters. Shorten it before importing.');
        for (let r = rowIndex; r < rowIndex + down; r++) {
          for (let c = column; c < column + across; c++) {
            if (grid[r][c]) fail('Merged cells overlap. Correct the table rowspan and colspan values.');
          }
        }
        for (let r = rowIndex; r < rowIndex + down; r++) {
          for (let c = column; c < column + across; c++) grid[r][c] = value;
        }
        merged ||= across > 1 || down > 1;
        cellCount++;
        column += across;
        width = Math.max(width, column);
      }
      width = Math.max(width, grid[rowIndex].length);
    }
    if (!cellCount || !width) fail('The selected table has no cells.');
    return {source, grid, width, merged};
  }

  function analyze(html) {
    return readDocument(html).map((table, index) => {
      const rows = tableRows(table);
      const caption = captionOf(table);
      // Metadata need not expand untrusted spans or reject another table: the
      // selected candidate is fully validated by parse().
      const columns = rows.reduce((maximum, row) => Math.max(maximum, row.cells.length), 0);
      const hasHeader = rows.some(row => row.parentElement.tagName === 'THEAD') || Boolean(rows[0] && Array.from(rows[0].cells).some(cell => cell.tagName === 'TH'));
      const label = 'Table ' + (index + 1) + (caption ? ': ' + caption.slice(0, 100) + (caption.length > 100 ? '…' : '') : '') + ' (' + rows.length + ' rows)';
      return {index, label, rows: rows.length, columns, caption, hasHeader};
    });
  }

  function parse(html, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('Choose a valid table to import.');
    const tables = readDocument(html);
    const index = options.tableIndex === undefined ? 0 : options.tableIndex;
    if (!Number.isInteger(index) || index < 0 || index >= tables.length) fail('Choose a table from the list before importing.');
    const {source, grid, width, merged} = expandTable(tables[index]);
    const headerRows = new Set();
    if (options.firstRowHeader !== false) {
      source.forEach((row, rowIndex) => { if (row.parentElement.tagName === 'THEAD') headerRows.add(rowIndex); });
      if (!headerRows.size) headerRows.add(0);
    }
    const warnings = [];
    if (merged) warnings.push('Merged cells were expanded into a regular grid. Their text is repeated in each covered cell.');
    const columns = [];
    let blankHeader = false;
    for (let column = 0; column < width; column++) {
      const labels = [];
      const seen = new Set();
      for (const rowIndex of headerRows) {
        const value = grid[rowIndex][column];
        if (value && value.text && !seen.has(value.id)) {
          seen.add(value.id);
          if (labels[labels.length - 1] !== value.text) labels.push(value.text);
        }
      }
      const label = labels.join(' / ');
      if (label.length > limits.label) fail('A column heading contains more than 80 characters. Shorten the heading or disable the header option.');
      if (headerRows.size && !label) blankHeader = true;
      columns.push(label || 'Column ' + (column + 1));
    }
    if (blankHeader) warnings.push('Blank column headings were named automatically. You can edit them before publishing.');
    const rows = grid.filter((row, rowIndex) => !headerRows.has(rowIndex)).map(row => Array.from({length: width}, (_, column) => row[column]?.text || ''));
    if (rows.length > limits.rows) fail('The selected table has more than 40 data rows. Split it into a smaller table.');
    if (grid.some(row => row.length < width || Array.from({length: width}, (_, column) => !row[column]).some(Boolean))) warnings.push('Short rows were padded with empty cells to match the table width.');
    // Reserve the full 80-character title budget, including JSON escaping, so
    // the existing routine title can be retained without exceeding the API cap.
    if (bytes(JSON.stringify({title: '\u0000'.repeat(limits.label), columns, rows})) > limits.bytes) fail('The converted routine is too large. Shorten its cell text before importing.');
    return {columns, rows, warnings, caption: captionOf(tables[index])};
  }

  window.ClassnestRoutineImport = Object.freeze({analyze, parse});
})();
