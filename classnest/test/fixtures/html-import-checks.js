/* Run with the real browser DOM via test/html-import-browser.html. The server
   must count requests to /canary and expose {canaryRequests} at /qa-stats. */
(() => {
  'use strict';
  const importer = window.ClassnestRoutineImport;
  const results = document.getElementById('results');
  const summary = document.getElementById('summary');
  const records = [];
  const equal = (actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Expected ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual));
  };
  const check = (name, fn) => {
    const row = document.createElement('li');
    try { fn(); row.textContent = 'PASS: ' + name; records.push({name, passed: true}); }
    catch (error) { row.textContent = 'FAIL: ' + name + ' — ' + error.message; records.push({name, passed: false, error: error.message}); }
    results.appendChild(row);
  };
  const rejects = (html, message, options) => {
    let caught;
    try { importer.parse(html, options); } catch (error) { caught = error; }
    if (!caught || !message.test(caught.message)) throw new Error('Expected rejection matching ' + message + '; received ' + (caught?.message || 'success'));
  };
  const table = rows => '<table>' + rows.map(cells => '<tr>' + cells.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</table>';

  check('Entities, line breaks, blocks, and text markup', () => {
    const parsed = importer.parse('<table><tr><th>Day &amp; date</th><th>Class</th></tr><tr><td>Sun&nbsp;day</td><td><p>Math &lt;3</p><div>Room 2<br>09:00</div></td></tr></table>');
    equal(parsed.columns, ['Day & date', 'Class']);
    equal(parsed.rows, [['Sun day', 'Math <3\n\nRoom 2\n09:00']]);
  });
  check('First row can be data with generated headings', () => {
    const parsed = importer.parse(table([['Sunday', 'Math'], ['Monday', 'Physics']]), {firstRowHeader: false});
    equal(parsed.columns, ['Column 1', 'Column 2']);
    equal(parsed.rows, [['Sunday', 'Math'], ['Monday', 'Physics']]);
  });
  check('td first row can be headings', () => {
    equal(importer.parse(table([['Day', 'Subject'], ['Sunday', 'Math']])).columns, ['Day', 'Subject']);
  });
  check('Multirow thead headings and merged cells', () => {
    const parsed = importer.parse('<table><thead><tr><th rowspan="2">Day</th><th colspan="2">Morning</th></tr><tr><th>9 AM</th><th>10 AM</th></tr></thead><tbody><tr><td rowspan="2">Sunday</td><td>Math</td><td>Physics</td></tr><tr><td colspan="2">Lab</td></tr></tbody></table>');
    equal(parsed.columns, ['Day', 'Morning / 9 AM', 'Morning / 10 AM']);
    equal(parsed.rows, [['Sunday', 'Math', 'Physics'], ['Sunday', 'Lab', 'Lab']]);
    if (!parsed.warnings.some(message => /Merged/.test(message))) throw new Error('Missing merged cell warning');
  });
  check('rowspan zero stays within its tbody group', () => {
    const parsed = importer.parse('<table><tr><th>Day</th><th>Class</th></tr><tbody><tr><td rowspan="0">Sunday</td><td>Math</td></tr><tr><td>Physics</td></tr></tbody><tbody><tr><td>Monday</td><td>Lab</td></tr></tbody></table>');
    equal(parsed.rows, [['Sunday', 'Math'], ['Sunday', 'Physics'], ['Monday', 'Lab']]);
  });
  check('Multiple and nested tables are selectable without outer duplication', () => {
    const html = '<table><caption>Weekly &amp; class</caption><tr><th>Day</th><th>Work</th></tr><tr><td>Sunday</td><td>Before<table><tr><td>Inner</td></tr><tr><td>Value</td></tr></table>After</td></tr></table><table><tr><th>Exam</th></tr><tr><td>Math</td></tr></table>';
    const metadata = importer.analyze(html);
    equal(metadata.length, 3);
    equal(metadata[0].rows, 2);
    equal(metadata[0].caption, 'Weekly & class');
    equal(importer.parse(html).rows, [['Sunday', 'BeforeAfter']]);
    equal(importer.parse(html, {tableIndex: 1}).rows, [['Value']]);
    equal(importer.parse(html, {tableIndex: 2}).rows, [['Math']]);
  });
  check('Short rows and empty headers are filled with explicit warnings', () => {
    const parsed = importer.parse(table([['', 'Subject'], ['Sunday']]));
    equal(parsed.columns, ['Column 1', 'Subject']);
    equal(parsed.rows, [['Sunday', '']]);
    equal(parsed.warnings.length, 2);
  });
  check('Scripts, event handlers, attributes, URLs, and foreign content are discarded', () => {
    const html = '<table><tr><th>Day</th></tr><tr><td onclick="window.__classnestImportExecuted=true"><script>window.__classnestImportExecuted=true</script><script src="/canary?script"></script><style>@import url("/canary?css");body{display:none}</style><iframe src="/canary?iframe"></iframe><object data="/canary?object">object text</object><svg><text>svg text</text></svg><template>template text</template><a href="javascript:window.__classnestImportExecuted=true">Sunday</a><img src="/canary?image" onerror="window.__classnestImportExecuted=true"><link rel="stylesheet" href="/canary?style"></td></tr></table>';
    const parsed = importer.parse(html);
    equal(parsed.rows, [['Sunday']]);
    equal(window.__classnestImportExecuted, undefined);
    if (document.querySelector('a[href^="javascript:"]')) throw new Error('Imported nodes reached the page');
  });
  check('Ignored template/iframe content does not become a candidate table', () => {
    equal(importer.analyze('<template><table><tr><td>Hidden</td></tr></table></template>' + table([['Day'], ['Sunday']])).length, 1);
  });
  check('No table and empty tables fail clearly', () => {
    rejects('<p>No table</p>', /No HTML table/);
    rejects('<table></table>', /no rows/);
    rejects('<table><tr></tr></table>', /no cells/);
  });
  check('Invalid table selection is rejected', () => {
    rejects(table([['Day']]), /Choose a table/, {tableIndex: 2});
    rejects(table([['Day']]), /Choose a table/, {tableIndex: -1});
  });
  check('Input byte limit applies to Unicode as well as ASCII', () => {
    rejects('x'.repeat(256 * 1024 + 1), /256 KiB/);
    rejects(table([['क'.repeat(90000)]]), /256 KiB/);
  });
  check('Huge, negative, decimal, and out-of-group spans fail before expansion', () => {
    for (const span of ['999999999', '-1', '1.5', '0']) rejects('<table><tr><td colspan="' + span + '">x</td></tr></table>', /colspan/);
    rejects('<table><tr><td rowspan="999999999">x</td></tr></table>', /rowspan/);
    rejects('<table><tr><td rowspan="2">x</td></tr></table>', /past its table section/);
  });
  check('Overlapping merged cells are rejected', () => {
    rejects('<table><tr><td>A</td><td rowspan="2">B</td></tr><tr><td colspan="2">C</td></tr></table>', /overlap/);
  });
  check('Column bounds include expansion and occupied cells', () => {
    rejects(table([Array(13).fill('x')]), /12 columns/);
    rejects('<table><tr><td colspan="12" rowspan="2">x</td></tr><tr><td>y</td></tr></table>', /12 columns/);
  });
  check('40 data rows pass; 41 are rejected', () => {
    equal(importer.parse(table([['Day'], ...Array.from({length: 40}, (_, i) => ['Day ' + i])])).rows.length, 40);
    rejects(table([['Day'], ...Array.from({length: 41}, () => ['Sunday'])]), /40 data rows/);
  });
  check('Header and cell text lengths are enforced without truncating', () => {
    equal(importer.parse(table([['x'.repeat(80)], ['x'.repeat(160)]])).rows[0][0].length, 160);
    rejects(table([['x'.repeat(81)], ['OK']]), /80 characters/);
    rejects(table([['Day'], ['x'.repeat(161)]]), /160 characters/);
  });
  check('At most 32 tables are accepted', () => {
    let caught;
    try { importer.analyze(table([['x']]).repeat(33)); } catch (error) { caught = error; }
    if (!caught || !/32 tables/.test(caught.message)) throw new Error('Missing table count rejection');
  });
  check('Serialized routine size is limited after cell expansion', () => {
    const cell = 'क'.repeat(160);
    rejects(table([Array(12).fill('Day'), ...Array.from({length: 40}, () => Array(12).fill(cell))]), /too large/);
  });
  check('Text resembling HTML stays literal text', () => {
    equal(importer.parse(table([['Class'], ['&lt;img src=x onerror=alert(1)&gt;']])).rows, [['<img src=x onerror=alert(1)>']]);
  });

  // Give inert resource/event work a turn before recording the final result.
  setTimeout(async () => {
    check('No imported scripts or resource events executed asynchronously', () => equal(window.__classnestImportExecuted, undefined));
    let statistics;
    let statisticsError;
    try {
      const response = await fetch('/qa-stats');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      statistics = await response.json();
    } catch (error) { statisticsError = error; }
    check('Imported resources made zero network requests', () => {
      if (statisticsError) throw new Error('Cannot check network canary: ' + statisticsError.message);
      equal(statistics.canaryRequests, 0);
    });
    const passed = records.filter(record => record.passed).length;
    summary.textContent = passed === records.length ? 'Passed ' + passed + ' checks' : 'FAILED: ' + passed + ' of ' + records.length + ' checks passed';
    document.title = passed === records.length ? 'PASS — HTML import' : 'FAIL — HTML import';
    window.__classnestHtmlImportChecks = Object.freeze({passed, total: records.length, records});
  }, 500);
})();
