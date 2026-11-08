import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const headingStart = source.indexOf('\nfunction heading(');
const renderStart = source.indexOf('function render(){');
const renderEnd = source.indexOf('\nfunction stopNotePreview(){');
assert.ok(headingStart > 0 && renderStart > headingStart && renderEnd > renderStart, 'The UI state and render functions must be available.');
const stateFlow = source.slice(0, headingStart);
const renderFlow = source.slice(renderStart, renderEnd);

function stateFor(user, semester) {
  return {
    user, selectedSemester: semester, semesterLocked: !!user && !['admin', 'teacher'].includes(user.role),
    settings: {name: 'Classnest', institution: 'PU', semester: 3},
    semesters: [{id: 3, name: 'Semester 3'}, {id: 4, name: 'Semester 4'}],
    subjects: [{id: 'subject-' + semester}], notes: [{id: 'note-' + semester, semester}],
    notices: [], events: [], threads: []
  };
}

// Exercise the real refresh, routing, and selector flow with explicit server responses.
// Browser layout and actual HTTP authorization are verified separately.
function browser({user = null, search = '?semester=4', hash = '#home'} = {}) {
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, open: false,
      classList: {add() {}, remove() {}},
      close() { this.open = false; this.closed = (this.closed || 0) + 1; },
      closest() { return this.label ??= {hidden: false}; }
    });
    return elements.get(selector);
  };
  const calls = [];
  let currentUser = user, hook = null, resets = 0;
  const location = {pathname: '/', search, hash};
  const history = {replaceState(unusedState, unusedTitle, value) {
    const next = new URL(value, 'https://pusoe.vercel.app');
    location.pathname = next.pathname; location.search = next.search; location.hash = next.hash;
  }};
  async function mockApi(url) {
    calls.push(url);
    if (hook) { const result = await hook(url); if (result !== undefined) return result; }
    const selected = new URL(url, 'https://pusoe.vercel.app').searchParams.get('semester');
    const locked = !!currentUser && !['admin', 'teacher'].includes(currentUser.role);
    if (locked && selected && Number(selected) !== currentUser.semester) throw Object.assign(Error('Students stay in their assigned semester.'), {status: 403});
    return stateFor(currentUser, selected ? Number(selected) : locked ? currentUser.semester : 3);
  }
  const context = vm.createContext({
    URLSearchParams, Intl, Date, location, history,
    localStorage: {getItem() { return '["note-4"]'; }},
    document: {querySelector: get, querySelectorAll() { return []; }},
    window: {ClassnestTeachingUI: {async load() {}, reset() { resets++; }}},
    mockApi, FormData: class {}, setTimeout() {}, clearTimeout() {}
  });
  vm.runInContext(stateFlow + '\n' + renderFlow + `
    api=mockApi;
    function stopNotePreview(){} function stopNoticeThumbnails(){} function syncNepalClock(){}
    function mountNoticeThumbnails(){} function loadMembers(){}
    function home(){return 'HOME '+selectedSemester+' '+state.notes.map(note=>note.id).join(',');}
    const subjects=home,subject=home,notices=home,schedule=home,discussions=home,savedPage=home,adminPage=home,searchPage=home,faqPage=home;
    globalThis.ui={refresh,selectSemester,read:()=>({state,selectedSemester,locked:semesterLocked(),saved:[...saved]})};
  `, context);
  return {
    ui: context.ui, get, calls, location,
    setUser(value) { currentUser = value; }, setHook(value) { hook = value; },
    get resets() { return resets; }
  };
}

const student = {id: 'student', name: 'Student', role: 'member', semester: 3, accountType: 'student'};

test('student URL choices load the assigned semester before rendering and lock the selector', async () => {
  const app = browser({user: student}); await app.ui.refresh();
  assert.deepEqual(app.calls, ['/state']);
  assert.equal(app.ui.read().selectedSemester, 3);
  assert.equal(app.get('#semester').disabled, true);
  assert.match(app.get('#semester').innerHTML, /Semester 3/);
  assert.doesNotMatch(app.get('#semester').innerHTML, /Semester 4/);
  assert.match(app.get('#semester-help').textContent, /set by administrator/);
  assert.equal(app.location.search, '?semester=3');
  assert.match(app.get('#main').innerHTML, /HOME 3 note-3/);
});

test('pending teacher requests and blocked accounts cannot bypass the student semester selector lock', async () => {
  for (const role of ['pending', 'blocked']) {
    const app = browser({user: {...student, role, accountType: 'teacher', semester: 4}, search: '?semester=3'});
    await app.ui.refresh();
    assert.equal(app.ui.read().selectedSemester, 4);
    assert.equal(app.ui.selectSemester(3), false);
    assert.equal(app.ui.read().selectedSemester, 4);
    assert.equal(app.get('#semester').disabled, true);
    assert.deepEqual(app.calls, ['/state']);
  }
});

test('approved teachers and administrators retain cross-semester UI browsing', async () => {
  for (const role of ['teacher', 'admin']) {
    const app = browser({user: {...student, role}}); await app.ui.refresh();
    assert.equal(app.ui.read().selectedSemester, 4);
    assert.equal(app.get('#semester').disabled, false);
    assert.deepEqual(app.calls, ['/state', '/state?semester=4']);
    assert.match(app.get('#semester').innerHTML, /Semester 3.*Semester 4/);
  }
});

test('student sign-in clears other-semester content and previews while sign-out restores visitor browsing', async () => {
  const app = browser(); await app.ui.refresh();
  assert.equal(app.ui.read().selectedSemester, 4);
  app.get('#modal').open = true; app.setUser(student); await app.ui.refresh();
  assert.equal(app.ui.read().selectedSemester, 3);
  assert.equal(app.get('#modal').open, false);
  assert.match(app.get('#main').innerHTML, /HOME 3 note-3/);
  assert.doesNotMatch(app.get('#main').innerHTML, /note-4/);
  assert.ok(app.resets > 0);
  app.setUser(null); await app.ui.refresh();
  assert.equal(app.get('#semester').disabled, false);
  assert.equal(app.ui.selectSemester(4), true);
  await app.ui.refresh(); assert.equal(app.ui.read().selectedSemester, 4);
});

test('administrator assignment changes replace the displayed student semester and stale note view on refresh', async () => {
  const app = browser({user: student, search: '?semester=3'}); await app.ui.refresh();
  app.get('#modal').open = true; app.setUser({...student, semester: 4}); await app.ui.refresh();
  assert.equal(app.ui.read().selectedSemester, 4);
  assert.equal(app.get('#modal').open, false);
  assert.equal(app.get('#semester').disabled, true);
  assert.equal(app.location.search, '?semester=4');
  assert.match(app.get('#main').innerHTML, /HOME 4 note-4/);
});

test('a UI role change between state reads falls back once to the safe default without a 403 loop', async () => {
  const app = browser({user: {...student, role: 'teacher'}});
  let changed = false;
  app.setHook(url => {
    if (url === '/state?semester=4' && !changed) {
      changed = true; app.setUser(student);
      throw Object.assign(Error('Permission changed'), {status: 403});
    }
  });
  await app.ui.refresh();
  assert.deepEqual(app.calls, ['/state', '/state?semester=4', '/state']);
  assert.equal(app.ui.read().selectedSemester, 3);
  assert.equal(app.get('#semester').disabled, true);
});
