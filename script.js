/* Campus Print Desk: application logic (plain JavaScript, no build step). */
(function () {
  'use strict';

  /* ---------- shop defaults. Staff change these live in the Settings tab ---------- */
  var DEFAULTS = {
    rates: {
      side: { A5: { bw: 0.75, colour: 6 }, A4: { bw: 1, colour: 10 }, A3: { bw: 4, colour: 25 } }, // rupees per printed side
      gsm: { 70: 0, 80: 0.25, 100: 1 },                                                            // extra rupees per sheet
      bind: { None: 0, Staple: 2, Spiral: 30, Thermal: 60 }                                         // rupees per copy
    },
    expressFee: 20,   // rupees added to an express job
    ppm: 10,          // sheets the desk finishes per minute, including handling (drives the wait estimate)
    open: true,
    notice: ''
  };
  var STATUS = { received: 'Received', printing: 'Printing', ready: 'Ready to collect', collected: 'Collected', rejected: 'Not accepted' };
  var STEPS = ['received', 'printing', 'ready', 'collected'];
  var EVENT_LABEL = { received: 'Opened by the print desk', printing: 'Printing started', ready: 'Ready to collect', collected: 'Collected', rejected: 'Not accepted' };
  var CATEGORIES = [['assignment', 'Assignment'], ['lab', 'Lab report'], ['project', 'Project report'], ['thesis', 'Thesis or dissertation'], ['notes', 'Study notes'], ['poster', 'Poster or drawing'], ['other', 'Other']];
  var CAT = {}; CATEGORIES.forEach(function (c) { CAT[c[0]] = c[1]; });
  var OPEN = ['received', 'printing', 'ready'];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function num(v, d, max) { v = Number(v); return isFinite(v) && v >= 0 && (max == null || v <= max) ? v : d; }
  function mergeSettings(raw) {
    var r = raw && typeof raw === 'object' ? raw : {}, rr = r.rates && typeof r.rates === 'object' ? r.rates : {}, out = clone(DEFAULTS);
    Object.keys(out.rates.side).forEach(function (p) {
      ['bw', 'colour'].forEach(function (m) { out.rates.side[p][m] = num(rr.side && rr.side[p] && rr.side[p][m], out.rates.side[p][m]); });
    });
    Object.keys(out.rates.gsm).forEach(function (g) { out.rates.gsm[g] = num(rr.gsm && rr.gsm[g], out.rates.gsm[g]); });
    Object.keys(out.rates.bind).forEach(function (b) { out.rates.bind[b] = num(rr.bind && rr.bind[b], out.rates.bind[b]); });
    out.expressFee = num(r.expressFee, DEFAULTS.expressFee, 1000);
    out.ppm = num(r.ppm, DEFAULTS.ppm, 200) || DEFAULTS.ppm;
    out.open = r.open !== false;
    out.notice = typeof r.notice === 'string' ? r.notice.slice(0, 200) : '';
    return out;
  }

  /* ---------- state ---------- */
  var state = {
    mode: 'local', ready: false, uid: null, isStaff: false, canWrite: true, assets: null, dl: null,
    settings: mergeSettings(null), setVersion: 0,
    docs: new Map(),        // queue/<uid> -> { jobs: { ref: job } }   (a student sees only their own)
    pub: new Map(),         // pub/<uid>   -> { jobs: { ref: { sheets, express, due, at } } }  (no personal data, readable by all)
    statuses: new Map(),    // status/<ref> -> { status, note, price, updatedAt, history }
    localJobs: [], localStatuses: new Map(), syncNote: ''
  };
  var ui = {
    trackRef: '', filter: 'open', editing: null, notifyOn: false, lastShown: [],
    rejecting: new Map(), collecting: new Map(), cancelAsk: new Set(), busy: new Set(), draft: new Map(),
    my: { text: '', status: 'all', cat: 'all' },
    q: { text: '', cat: 'all', paper: 'all', colour: 'all', prio: 'all', sort: 'due' },
    setBuilt: false, setDirty: false, setSeen: -1
  };
  var dbApi = null;

  /* ---------- standalone mode: no shared database, so data lives in this browser (localStorage) ---------- */
  var LS_KEY = 'printdesk.v1';
  function persistLocal() {
    if (state.mode !== 'local') return;
    try { localStorage.setItem(LS_KEY, JSON.stringify({ jobs: state.localJobs, statuses: Array.from(state.localStatuses.entries()), settings: state.settings })); }
    catch (e) { /* storage blocked: data stays in memory for this visit */ }
  }
  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY); if (!raw) return;
      var d = JSON.parse(raw);
      if (Array.isArray(d.jobs)) state.localJobs = d.jobs;
      if (Array.isArray(d.statuses)) state.localStatuses = new Map(d.statuses);
      if (d.settings) state.settings = mergeSettings(d.settings);
    } catch (e) { /* ignore unreadable saved data */ }
  }
  var localDownloader = {
    save: function (o) {
      return new Promise(function (resolve, reject) {
        try {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([o.data], { type: 'text/csv;charset=utf-8' }));
          a.download = o.filename; document.body.append(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
          resolve({ status: 'saved' });
        } catch (e) { reject({ code: 'unavailable' }); }
      });
    }
  };

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs) {
    var e = document.createElement(tag), a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      [].concat(arguments[i]).forEach(function (c) { if (c == null || c === false) return; e.append(c.nodeType ? c : document.createTextNode(String(c))); });
    }
    return e;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { var p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function daysFromToday(s) { var t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((parseYmd(s) - t) / 864e5); }
  function dueLabel(s) {
    var d = daysFromToday(s);
    if (isNaN(d)) return { text: '', late: false };
    if (d === 0) return { text: 'Due today', late: false };
    if (d === 1) return { text: 'Due tomorrow', late: false };
    if (d < 0) return { text: 'Overdue by ' + (-d) + (d === -1 ? ' day' : ' days'), late: true };
    return { text: 'Due ' + parseYmd(s).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }), late: false };
  }
  function money(n) {
    var r = Math.round(n * 100) / 100;
    return '₹' + r.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 });
  }
  function fmtMin(m) { if (m < 60) return m + ' min'; var hh = Math.floor(m / 60), r = m % 60; return hh + ' h' + (r ? ' ' + r + ' min' : ''); }
  function fmtSpan(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    if (m < 2880) return (Math.round(m / 6) / 10) + ' h';
    return (Math.round(m / 144) / 10) + ' days';
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function calc(v) {
    var S = state.settings, R = S.rates;
    var pages = Math.max(0, parseInt(v.pages, 10) || 0), copies = Math.max(0, parseInt(v.copies, 10) || 0);
    var sheets = (v.sides === 'double' ? Math.ceil(pages / 2) : pages) * copies, sides = pages * copies;
    var rate = (R.side[v.paper] || R.side.A4)[v.colour === 'colour' ? 'colour' : 'bw'];
    var printing = sides * rate, paper = sheets * (R.gsm[String(v.gsm)] || 0), binding = copies * (R.bind[v.binding] || 0);
    var express = v.priority === 'express' ? S.expressFee : 0;
    return { pages: pages, copies: copies, sheets: sheets, sides: sides, printing: printing, paper: paper, binding: binding, express: express, total: printing + paper + binding + express };
  }
  function colourName(c) { return c === 'colour' ? 'Colour' : 'B&W'; }
  function specLine(j) {
    var n = Number(j.copies) || 1;
    return [j.paper, colourName(j.colour), j.sides === 'double' ? 'Double-sided' : 'Single-sided', j.gsm + ' GSM',
      j.binding && j.binding !== 'None' ? j.binding + ' binding' : 'No binding',
      n + (n === 1 ? ' copy' : ' copies') + ' x ' + (Number(j.pages) || 0) + ' pp'].join(' · ');
  }
  function say(msg) { var b = $('banner'); b.textContent = msg; b.hidden = !msg; }
  function toast(msg, kind) {
    var t = h('div', { class: 'toast ' + (kind === 'bad' ? 'bad' : 'ok'), text: msg });
    $('toasts').append(t);
    setTimeout(function () { t.remove(); }, kind === 'bad' ? 8000 : 6000);
  }
  function safeLink(s) { return typeof s === 'string' && /^https:\/\/\S+$/i.test(s) ? s : ''; }
  function fileUrl(id) { return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? '/_blob/' + id : ''; }
  function catLabel(j) { return CAT[j.category] || 'Other'; }
  function isExpress(j) { return j && j.priority === 'express'; }
  function fillSelect(sel, pairs) { sel.replaceChildren(); pairs.forEach(function (p) { sel.append(h('option', { value: p[0], text: p[1] })); }); }
  function newPin() {
    try { var a = new Uint32Array(1); crypto.getRandomValues(a); return String(1000 + a[0] % 9000); } catch (e) { return String(1000 + Math.floor(Math.random() * 9000)); }
  }

  /* ---------- data access ---------- */
  function statusInfo(ref) {
    var s = state.mode === 'db' ? state.statuses.get(ref) : state.localStatuses.get(ref);
    if (!s || !STATUS[s.status]) return { status: 'received', note: '', price: null, updatedAt: '', explicit: false, history: [] };
    return {
      status: s.status, note: typeof s.note === 'string' ? s.note : '',
      price: typeof s.price === 'number' && isFinite(s.price) ? s.price : null, updatedAt: s.updatedAt || '', explicit: true,
      history: Array.isArray(s.history) ? s.history.filter(function (x) { return x && STATUS[x.s] && typeof x.at === 'string'; }) : []
    };
  }
  function allJobs() {
    if (state.mode !== 'db') return state.localJobs.slice();
    var out = [];
    state.docs.forEach(function (d, id) {
      var jobs = d && d.jobs && typeof d.jobs === 'object' ? d.jobs : {};
      Object.keys(jobs).forEach(function (ref) { var j = jobs[ref]; if (j && typeof j === 'object') out.push(Object.assign({}, j, { ref: ref, owner: id })); });
    });
    return out;
  }
  function myJobs() {
    if (state.mode !== 'db') return state.localJobs.slice();
    var d = state.uid ? state.docs.get(state.uid) : null, jobs = d && d.jobs && typeof d.jobs === 'object' ? d.jobs : {};
    return Object.keys(jobs).map(function (ref) { return Object.assign({}, jobs[ref], { ref: ref }); });
  }
  function byDue(a, b) {
    return (isExpress(b) ? 1 : 0) - (isExpress(a) ? 1 : 0) || String(a.due).localeCompare(String(b.due)) || String(a.createdAt).localeCompare(String(b.createdAt));
  }
  function pubEntries() {
    if (state.mode !== 'db') return state.localJobs.map(function (j) { return { ref: j.ref, sheets: calc(j).sheets, express: isExpress(j), due: j.due, at: j.createdAt }; });
    var out = [];
    state.pub.forEach(function (d) {
      var jobs = d && d.jobs && typeof d.jobs === 'object' ? d.jobs : {};
      Object.keys(jobs).forEach(function (ref) { var e = jobs[ref]; if (e && typeof e === 'object') out.push({ ref: ref, sheets: Number(e.sheets) || 0, express: !!e.express, due: e.due || '', at: e.at || '' }); });
    });
    return out;
  }
  /* queue position and wait estimate, built from the anonymous pub entries so students never see other people's jobs */
  function queueInfo(ref) {
    var list = pubEntries().filter(function (e) { var s = statusInfo(e.ref).status; return s === 'received' || s === 'printing'; });
    list.sort(function (a, b) {
      var pa = statusInfo(a.ref).status === 'printing' ? 1 : 0, pb = statusInfo(b.ref).status === 'printing' ? 1 : 0;
      return pb - pa || (b.express ? 1 : 0) - (a.express ? 1 : 0) || String(a.due).localeCompare(String(b.due)) || String(a.at).localeCompare(String(b.at));
    });
    var idx = -1, sheets = 0;
    for (var i = 0; i < list.length; i++) { sheets += list[i].sheets; if (list[i].ref === ref) { idx = i; break; } }
    if (idx < 0) return null;
    return { pos: idx + 1, total: list.length, minutes: Math.max(1, Math.ceil(sheets / state.settings.ppm)) };
  }
  function etaText(ref, status) {
    if (status !== 'received' && status !== 'printing') return '';
    var q = queueInfo(ref);
    if (!q) return '';
    if (status === 'printing') return 'Printing now. About ' + fmtMin(q.minutes) + ' to finish.';
    return 'Place ' + q.pos + ' of ' + q.total + ' in the queue. About ' + fmtMin(q.minutes) + ' until it is ready.';
  }

  async function saveJob(job) {
    var entry = { sheets: calc(job).sheets, express: isExpress(job), due: job.due, at: job.createdAt };
    if (state.mode !== 'db') {
      var i = state.localJobs.findIndex(function (j) { return j.ref === job.ref; }), rec = Object.assign({ owner: 'local' }, job);
      if (i >= 0) state.localJobs[i] = rec; else state.localJobs.push(rec);
      persistLocal(); render(); return;
    }
    if (!state.uid) { var e = new Error('no id'); e.code = 'no_identity'; throw e; }
    var ref = dbApi.doc('queue/' + state.uid), snap = await ref.get();
    var jobs = snap.exists && snap.data() && snap.data().jobs ? Object.assign({}, snap.data().jobs) : {};
    jobs[job.ref] = job;
    await ref.set({ jobs: jobs });
    try {
      var pr = dbApi.doc('pub/' + state.uid), ps = await pr.get();
      var pj = ps.exists && ps.data() && ps.data().jobs ? Object.assign({}, ps.data().jobs) : {};
      pj[job.ref] = entry;
      await pr.set({ jobs: pj });
    } catch (x) { /* the wait estimate is best effort; the request itself is saved */ }
  }
  async function cancelJob(ref) {
    if (state.mode !== 'db') { state.localJobs = state.localJobs.filter(function (j) { return j.ref !== ref; }); persistLocal(); render(); return; }
    var d = dbApi.doc('queue/' + state.uid), snap = await d.get();
    var jobs = snap.exists && snap.data() && snap.data().jobs ? Object.assign({}, snap.data().jobs) : {};
    delete jobs[ref];
    await d.set({ jobs: jobs });
    try {
      var pr = dbApi.doc('pub/' + state.uid), ps = await pr.get();
      var pj = ps.exists && ps.data() && ps.data().jobs ? Object.assign({}, ps.data().jobs) : {};
      delete pj[ref];
      await pr.set({ jobs: pj });
    } catch (x) { /* best effort */ }
  }
  async function setStatus(ref, status, note, price) {
    var prev = (state.mode === 'db' ? state.statuses.get(ref) : state.localStatuses.get(ref)) || {};
    var hist = Array.isArray(prev.history) ? prev.history.slice(-20) : [], at = new Date().toISOString();
    if (prev.status !== status) hist.push({ s: status, at: at });
    var rec = { status: status, note: note || '', price: price == null ? null : price, updatedAt: at, history: hist };
    if (state.mode !== 'db') { state.localStatuses.set(ref, rec); persistLocal(); render(); return; }
    await dbApi.doc('status/' + ref).set(rec);
  }

  /* ---------- request form ---------- */
  var form = $('reqForm');
  function fv(name) { return form.elements.namedItem(name); }
  function values() {
    return { name: fv('name').value, roll: fv('roll').value, dept: fv('dept').value, category: fv('category').value, title: fv('title').value,
      link: fv('link').value, pages: fv('pages').value, copies: fv('copies').value, paper: fv('paper').value, colour: fv('colour').value,
      sides: fv('sides').value, gsm: fv('gsm').value, binding: fv('binding').value, priority: fv('priority').value, due: fv('due').value, notes: fv('notes').value };
  }
  function setRadio(name, val) { var list = fv(name); for (var i = 0; i < list.length; i++) list[i].checked = list[i].value === val; }
  function updateTicket() {
    var v = values(), c = calc(v), R = state.settings.rates;
    $('tk-paper').textContent = v.paper + ' · ' + v.gsm + ' GSM';
    $('tk-mode').textContent = colourName(v.colour) + ' · ' + (v.sides === 'double' ? 'Double' : 'Single') + '-sided';
    $('tk-pages').textContent = c.pages + ' x ' + c.copies;
    $('tk-sheets').textContent = c.sheets;
    $('tk-binding').textContent = v.binding === 'None' ? 'None' : v.binding + ' (' + money(R.bind[v.binding] || 0) + ' per copy)';
    $('tk-prio').textContent = v.priority === 'express' ? 'Express (+' + money(state.settings.expressFee) + ')' : 'Standard';
    $('tk-total').textContent = money(c.total);
    $('tk-break').textContent = 'Printing ' + money(c.printing) + ', paper ' + money(c.paper) + ', binding ' + money(c.binding) + (c.express ? ', express ' + money(c.express) : '') + '.';
    $('bar').setAttribute('data-mode', v.colour === 'colour' ? 'colour' : 'bw');
    $('tk-ref').textContent = ui.editing || 'Ref on submit';
  }
  function validate(v) {
    var e = {}, today = ymd(new Date()), p = Number(v.pages), n = Number(v.copies);
    if (!v.name.trim()) e.name = 'Enter the name the counter should call.';
    if (!/^[A-Za-z0-9\-\/ ]{3,24}$/.test(v.roll.trim())) e.roll = 'Enter your roll number or staff ID (letters, numbers, - or /).';
    if (!v.dept.trim()) e.dept = 'Enter your department or hostel block.';
    if (!v.title.trim()) e.title = 'Give the document a name so the shop can find it.';
    if (v.link.trim() && !/^https:\/\/\S+$/i.test(v.link.trim())) e.link = 'Paste the full link, starting with https://';
    if (!Number.isInteger(p) || p < 1 || p > 500) e.pages = 'Enter a whole number from 1 to 500.';
    if (!Number.isInteger(n) || n < 1 || n > 100) e.copies = 'Enter a whole number from 1 to 100.';
    if (!v.due) e.due = 'Pick the date you need it by.';
    else if (v.due < today) e.due = 'Pick today or a later date.';
    return e;
  }
  var FIELDS = ['name', 'roll', 'dept', 'title', 'file', 'link', 'pages', 'copies', 'due'];
  function showErrors(errs) {
    FIELDS.forEach(function (k) {
      var inp = $(k), box = $('err-' + k);
      box.textContent = errs[k] || '';
      if (errs[k]) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid');
    });
    var first = FIELDS.filter(function (k) { return errs[k]; })[0];
    if (first) $(first).focus();
  }
  function newRef() { return 'PR-' + (Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 5)).toUpperCase(); }
  function formAlert(msg) { var a = $('formError'); a.textContent = msg; a.hidden = !msg; }
  function uploadMessage(e) {
    var c = e && e.code;
    if (c === 'too_large') return 'The file is over 20 MB. Compress it or paste a link instead.';
    if (c === 'unsupported_type') return 'That file type is not accepted. Use PDF, PNG or JPEG.';
    if (c === 'quota_or_state') return 'The portal has no storage left for files. Paste a link or bring the file on a pen drive.';
    if (c === 'not_granted' || c === 'capability_disabled' || c === 'capability_removed') return 'File upload is not available for your account. Paste a link instead.';
    return 'The file could not be uploaded. Check your connection and try again, or paste a link.';
  }
  function defaultDue() { var d = new Date(); d.setDate(d.getDate() + 2); return ymd(d); }
  function clearJobFields() {
    ['title', 'link', 'notes'].forEach(function (k) { fv(k).value = ''; });
    fv('file').value = ''; $('fileNote').textContent = '';
    fv('pages').value = 12; fv('copies').value = 1; fv('category').value = 'assignment';
    fv('gsm').value = '80'; fv('binding').value = 'None';
    setRadio('paper', 'A4'); setRadio('colour', 'bw'); setRadio('sides', 'single'); setRadio('priority', 'standard');
    fv('due').value = defaultDue();
    showErrors({}); formAlert(''); updateTicket();
  }
  function fillForm(job) {
    ['name', 'roll', 'dept', 'title', 'link', 'notes'].forEach(function (k) { fv(k).value = job[k] || ''; });
    fv('pages').value = job.pages; fv('copies').value = job.copies; fv('category').value = CAT[job.category] ? job.category : 'other';
    fv('gsm').value = String(job.gsm); fv('binding').value = job.binding; fv('due').value = job.due;
    setRadio('paper', job.paper); setRadio('colour', job.colour); setRadio('sides', job.sides); setRadio('priority', isExpress(job) ? 'express' : 'standard');
    fv('file').value = '';
  }
  function startEdit(job) {
    ui.editing = job.ref; fillForm(job);
    $('fileNote').textContent = job.fileId ? 'Current file: ' + (job.fileName || 'uploaded file') + '. Choose a new file only if you want to replace it.' : '';
    showErrors({}); formAlert(''); updateTicket();
    $('confirm').hidden = true; $('formLayout').hidden = false;
    location.hash = '#request'; render();
  }
  function startCopy(job) {
    ui.editing = null; fillForm(job); fv('due').value = defaultDue(); $('fileNote').textContent = '';
    showErrors({}); formAlert(''); updateTicket();
    $('confirm').hidden = true; $('formLayout').hidden = false;
    location.hash = '#request'; render();
    toast('Settings copied from ' + job.ref + '. Add your file, check the date and send.', 'ok');
  }
  function stopEdit() { ui.editing = null; clearJobFields(); render(); }
  function applyMode() {
    var ed = !!ui.editing, S = state.settings;
    $('h-request').textContent = ed ? 'Update request ' + ui.editing : 'Send a job to the print desk';
    $('leadRequest').hidden = ed;
    $('editBar').hidden = !ed;
    $('editBar').textContent = ed ? 'You are editing ' + ui.editing + '. You can change it until the print desk opens the job.' : '';
    $('submitBtn').textContent = ed ? 'Save changes' : 'Send to print desk';
    $('cancelEdit').hidden = !ed;
    $('fileField').hidden = !state.assets;
    $('expressLabel').textContent = 'Express (+' + money(S.expressFee) + ')';
    $('prioHint').textContent = 'Express jobs go to the front of the queue. Use it for same-day deadlines.';
    updateTicket();
  }

  form.addEventListener('input', function (ev) {
    updateTicket();
    var t = ev.target;
    if (t.hasAttribute && t.hasAttribute('aria-invalid')) { t.removeAttribute('aria-invalid'); var b = $('err-' + t.id); if (b) b.textContent = ''; }
  });
  form.addEventListener('change', updateTicket);
  $('cancelEdit').addEventListener('click', function () { stopEdit(); location.hash = '#track'; });

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    formAlert('');
    if (!state.settings.open && !state.isStaff) { formAlert('The print desk is not taking new requests right now. Check the notice at the top of the page.'); return; }
    var v = values(), errs = validate(v);
    var file = state.assets && fv('file').files ? fv('file').files[0] : null;
    if (file) {
      if (!/^(application\/pdf|image\/png|image\/jpeg)$/.test(file.type)) errs.file = 'Choose a PDF, PNG or JPEG. Save Word files as PDF first.';
      else if (file.size > 20 * 1024 * 1024) errs.file = 'This file is over 20 MB. Compress it or paste a link instead.';
    }
    showErrors(errs);
    if (Object.keys(errs).length) { formAlert('Fix the highlighted fields and send again.'); return; }
    if (!state.canWrite) { formAlert('This account can view the portal but not send requests. Ask the page owner to share it with you as a Contributor.'); return; }
    var existing = null;
    if (ui.editing) {
      existing = myJobs().filter(function (j) { return j.ref === ui.editing; })[0];
      if (!existing) { formAlert('This request no longer exists. Send it again as a new request.'); return; }
      if (statusInfo(existing.ref).explicit) { formAlert('The print desk has already opened this job, so it can no longer be edited. Ask at the counter.'); return; }
    }
    var c = calc(v), now = new Date().toISOString();
    var job = {
      ref: existing ? existing.ref : newRef(), pin: existing && existing.pin ? existing.pin : newPin(),
      name: v.name.trim(), roll: v.roll.trim(), dept: v.dept.trim(), category: v.category,
      title: v.title.trim(), link: v.link.trim(), pages: c.pages, copies: c.copies, paper: v.paper, colour: v.colour, sides: v.sides,
      gsm: Number(v.gsm), binding: v.binding, priority: v.priority === 'express' ? 'express' : 'standard', due: v.due, notes: v.notes.trim(), estimate: c.total,
      createdAt: existing ? existing.createdAt : now
    };
    if (existing) job.updatedAt = now;
    if (existing && existing.fileId) { job.fileId = existing.fileId; job.fileName = existing.fileName; job.fileSize = existing.fileSize; }
    var btn = $('submitBtn'), label = btn.textContent;
    btn.disabled = true; btn.textContent = file ? 'Uploading file...' : 'Sending...';
    try {
      if (file) {
        var up;
        try { up = await state.assets.upload(file); } catch (ue) { formAlert(uploadMessage(ue)); return; }
        if (existing && existing.fileId) { try { state.assets.delete(existing.fileId).catch(function () {}); } catch (x) { /* old file stays */ } }
        job.fileId = up.id; job.fileName = file.name; job.fileSize = file.size;
      }
      await saveJob(job);
      if (existing) {
        ui.editing = null; ui.trackRef = job.ref; clearJobFields();
        toast('Request ' + job.ref + ' updated.', 'ok');
        location.hash = '#track'; render();
      } else {
        $('confirmRef').textContent = job.ref;
        $('confirmSub').textContent = job.title + ' · ' + specLine(job) + ' · estimate ' + money(job.estimate) + '. Keep this number.';
        $('confirmPin').textContent = 'Your pickup PIN is ' + job.pin + '. Show it at the counter to collect. You can see it again under My requests.';
        $('copyMsg').textContent = '';
        $('formLayout').hidden = true; $('confirm').hidden = false;
        toast('Request ' + job.ref + ' sent to the print desk.', 'ok');
        $('confirm').scrollIntoView({ block: 'start' });
      }
    } catch (err) {
      var code = err && err.code;
      if (code === 'no_identity') formAlert('You need to be signed in to send a request.');
      else if (code === 'quota_exceeded') formAlert('The portal has reached its storage limit. Tell the print desk so they can clear old jobs.');
      else if (code === 'invalid_argument') formAlert('This account can view the portal but not send requests. Ask the page owner to share it with you as a Contributor.');
      else formAlert('The request could not be saved. Check your connection and try again. Your answers are still in the form.');
    } finally {
      btn.textContent = label; render();
    }
  });
  $('another').addEventListener('click', function () {
    clearJobFields(); $('confirm').hidden = true; $('formLayout').hidden = false; $('title').focus();
  });
  $('copyRef').addEventListener('click', function () {
    var text = $('confirmRef').textContent;
    function fallback() {
      var r = document.createRange(); r.selectNodeContents($('confirmRef'));
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      $('copyMsg').textContent = 'Number selected. Copy it with your keyboard.';
    }
    try { navigator.clipboard.writeText(text).then(function () { $('copyMsg').textContent = 'Copied ' + text + '.'; }, fallback); } catch (e) { fallback(); }
  });

  /* ---------- shared pieces ---------- */
  function pill(status) { return h('span', { class: 'pill st-' + status, text: STATUS[status] }); }
  function expressBadge(j) { return isExpress(j) ? h('span', { class: 'xbadge', text: 'Express' }) : null; }
  function stepper(status) {
    var rej = status === 'rejected', idx = STEPS.indexOf(status);
    return h('ol', { class: 'steps' + (rej ? ' rej' : ''), 'aria-label': 'Progress' }, STEPS.map(function (s, i) {
      var on = rej ? i === 0 : i <= idx;
      return h('li', { class: on ? 'on' : '', 'aria-current': (!rej && i === idx) ? 'step' : null, text: STATUS[s] });
    }));
  }
  function timeline(job, info) {
    var ev = [];
    if (job && job.createdAt) ev.push(['Request submitted', job.createdAt]);
    info.history.forEach(function (x) { ev.push([EVENT_LABEL[x.s] || x.s, x.at]); });
    if (!ev.length) return null;
    return h('ol', { class: 'timeline', 'aria-label': 'Status history' }, ev.map(function (e) { return h('li', {}, h('span', { class: 'tl-t', text: fmtTime(e[1]) }), h('span', { text: e[0] })); }));
  }
  function stat(label, value, note, hot) {
    return h('div', { class: 'stat' + (hot ? ' hot' : '') }, h('span', { class: 'k', text: label }), h('span', { class: 'v', text: String(value) }), note ? h('span', { class: 'n', text: note }) : null);
  }
  function matchText(j, text) {
    if (!text) return true;
    var hay = [j.ref, j.name, j.roll, j.dept, j.title, catLabel(j)].join(' ').toLowerCase();
    return text.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) >= 0; });
  }
  function priceOf(j) { var s = statusInfo(j.ref); return s.price != null ? s.price : (Number(j.estimate) || 0); }

  /* ---------- my requests ---------- */
  function renderTrack() {
    var mine = myJobs().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    var inProg = 0, ready = 0, toPay = 0;
    mine.forEach(function (j) {
      var s = statusInfo(j.ref).status;
      if (s === 'received' || s === 'printing') inProg++;
      if (s === 'ready') ready++;
      if (OPEN.indexOf(s) >= 0) toPay += priceOf(j);
    });
    $('sumMine').replaceChildren(stat('Requests', mine.length), stat('In progress', inProg), stat('Ready to collect', ready), stat('To pay at counter', money(toPay), 'Estimate for open jobs'));

    var ref = ui.trackRef, box = $('trackResult'); box.replaceChildren();
    if (ref) {
      var job = mine.filter(function (j) { return j.ref === ref; })[0], info = statusInfo(ref);
      if (!job && !info.explicit) {
        box.append(h('div', { class: 'panel result' }, h('h3', { text: 'Nothing found for ' + ref }),
          h('p', { text: 'Check the number for typos. A job from someone else shows up here only after the print desk has opened it.' })));
      } else {
        var kids = [h('div', { class: 'job-top' }, h('span', { class: 'ref', text: ref }), pill(info.status), job ? h('span', { class: 'cat', text: catLabel(job) }) : null, job ? expressBadge(job) : null)];
        kids.push(h('h3', { text: job ? job.title : 'Request ' + ref }));
        kids.push(stepper(info.status));
        var eta = etaText(ref, info.status);
        if (eta) kids.push(h('p', { class: 'eta', text: eta }));
        if (info.status === 'ready') kids.push(h('p', { text: 'Your job is at the counter. Bring your ID card' + (job && job.pin ? ' and your pickup PIN ' + job.pin : '') + '.' }));
        if (info.status === 'rejected') kids.push(h('p', { text: 'The print desk could not accept this job.' }));
        if (info.note) kids.push(h('p', { text: 'Note from the print desk: ' + info.note }));
        if (info.price != null) kids.push(h('p', { text: 'Final price: ' + money(info.price) }));
        if (job) kids.push(h('p', { class: 'meta', text: specLine(job) + ' · estimate ' + money(Number(job.estimate) || 0) }));
        var tl = timeline(job, info); if (tl) kids.push(tl);
        box.append(h('div', { class: 'panel result' }, kids));
      }
    }
    var f = ui.my;
    var shown = mine.filter(function (j) {
      var s = statusInfo(j.ref).status;
      if (f.status === 'open' && OPEN.indexOf(s) < 0) return false;
      if (f.status !== 'all' && f.status !== 'open' && s !== f.status) return false;
      if (f.cat !== 'all' && j.category !== f.cat) return false;
      return matchText(j, f.text);
    });
    $('myCount').textContent = mine.length ? 'Showing ' + shown.length + ' of ' + mine.length + (mine.length === 1 ? ' request' : ' requests') : '';
    var list = $('myList'); list.replaceChildren();
    if (!mine.length) {
      list.append(h('div', { class: 'empty' }, h('b', { text: 'No requests yet' }), 'Jobs you send appear here with their live status. ', h('a', { href: '#request', text: 'Send your first job' }), '.'));
      return;
    }
    if (!shown.length) { list.append(h('div', { class: 'empty' }, h('b', { text: 'No requests match' }), 'Change the search or status filter above.')); return; }
    var ul = h('ul', { class: 'jobs' });
    shown.forEach(function (j) {
      var info = statusInfo(j.ref), due = dueLabel(j.due), editable = !info.explicit && state.canWrite, open = OPEN.indexOf(info.status) >= 0;
      var btns = [h('button', { class: 'btn small', type: 'button', onclick: function () { ui.trackRef = j.ref; $('refInput').value = j.ref; renderTrack(); $('trackResult').scrollIntoView({ block: 'nearest' }); } }, 'View status')];
      if (state.canWrite) btns.push(h('button', { class: 'btn small', type: 'button', onclick: function () { startCopy(j); } }, 'Reorder'));
      if (editable) {
        btns.push(h('button', { class: 'btn small', type: 'button', onclick: function () { startEdit(j); } }, 'Edit'));
        if (ui.cancelAsk.has(j.ref)) {
          btns.push(h('button', { class: 'btn small danger', type: 'button', disabled: ui.busy.has(j.ref), onclick: async function () {
            ui.busy.add(j.ref); renderTrack();
            try { await cancelJob(j.ref); toast('Request ' + j.ref + ' cancelled.', 'ok'); } catch (e) { toast('Could not cancel ' + j.ref + '. Try again.', 'bad'); }
            ui.busy.delete(j.ref); ui.cancelAsk.delete(j.ref); renderTrack();
          } }, 'Yes, cancel it'));
          btns.push(h('button', { class: 'btn small', type: 'button', onclick: function () { ui.cancelAsk.delete(j.ref); renderTrack(); } }, 'Keep it'));
        } else {
          btns.push(h('button', { class: 'btn small', type: 'button', onclick: function () { ui.cancelAsk.add(j.ref); renderTrack(); } }, 'Cancel'));
        }
      }
      var eta = etaText(j.ref, info.status);
      ul.append(h('li', { class: 'job' },
        h('div', { class: 'job-main' },
          h('div', { class: 'job-top' }, h('span', { class: 'ref', text: j.ref }), pill(info.status), h('span', { class: 'cat', text: catLabel(j) }), expressBadge(j),
            h('span', { class: 'due' + (due.late && open ? ' late' : ''), text: due.text })),
          h('div', { class: 'job-title', text: j.title }),
          h('div', { class: 'meta', text: specLine(j) }),
          eta ? h('div', { class: 'meta eta', text: eta }) : null,
          open && j.pin ? h('div', { class: 'meta' }, 'Pickup PIN ', h('b', { class: 'pin', text: j.pin })) : null,
          j.fileName ? h('div', { class: 'meta', text: 'File: ' + j.fileName }) : null,
          info.note ? h('div', { class: 'meta', text: 'Note from the print desk: ' + info.note }) : null),
        h('div', { class: 'job-side' }, h('span', { class: 'money', text: money(priceOf(j)) }), h('div', { class: 'job-btns' }, btns))));
    });
    list.append(ul);
  }
  $('lookupForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    ui.trackRef = $('refInput').value.trim().toUpperCase().replace(/\s+/g, '');
    if (!ui.trackRef) toast('Enter a request number such as PR-3K9XA7F.', 'bad');
    renderTrack();
  });
  $('mySearch').addEventListener('input', function (e) { ui.my.text = e.target.value.trim(); renderTrack(); });
  $('myStatus').addEventListener('change', function (e) { ui.my.status = e.target.value; renderTrack(); });
  $('myCat').addEventListener('change', function (e) { ui.my.cat = e.target.value; renderTrack(); });

  /* ---------- queue ---------- */
  var NEXT = { received: ['printing', 'Start printing'], printing: ['ready', 'Mark ready'] };
  function getDraft(ref, info) {
    if (!ui.draft.has(ref)) ui.draft.set(ref, { open: false, note: info.note || '', price: info.price != null ? String(info.price) : '' });
    return ui.draft.get(ref);
  }
  function renderQueue() {
    var jobs = allJobs();
    var counts = { open: 0, received: 0, printing: 0, ready: 0, done: 0, all: jobs.length };
    jobs.forEach(function (j) { var s = statusInfo(j.ref).status; if (OPEN.indexOf(s) >= 0) counts.open++; if (s === 'collected' || s === 'rejected') counts.done++; else counts[s]++; });
    var fl = $('filters'); fl.replaceChildren();
    [['open', 'Open'], ['received', 'Received'], ['printing', 'Printing'], ['ready', 'Ready'], ['done', 'Closed'], ['all', 'All']].forEach(function (f) {
      fl.append(h('button', { type: 'button', 'aria-pressed': String(ui.filter === f[0]), onclick: function () { ui.filter = f[0]; renderQueue(); } }, f[1] + ' ' + counts[f[0]]));
    });
    var q = ui.q;
    var shown = jobs.filter(function (j) {
      var s = statusInfo(j.ref).status;
      if (ui.filter === 'open' && OPEN.indexOf(s) < 0) return false;
      if (ui.filter === 'done' && s !== 'collected' && s !== 'rejected') return false;
      if (['received', 'printing', 'ready'].indexOf(ui.filter) >= 0 && s !== ui.filter) return false;
      if (q.cat !== 'all' && j.category !== q.cat) return false;
      if (q.paper !== 'all' && j.paper !== q.paper) return false;
      if (q.colour !== 'all' && j.colour !== q.colour) return false;
      if (q.prio === 'express' && !isExpress(j)) return false;
      return matchText(j, q.text);
    });
    shown.sort(q.sort === 'new' ? function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }
      : q.sort === 'price' ? function (a, b) { return priceOf(b) - priceOf(a); } : byDue);
    ui.lastShown = shown;
    $('exportBtn').hidden = !state.dl;
    $('qCount').textContent = jobs.length ? 'Showing ' + shown.length + ' of ' + jobs.length + (jobs.length === 1 ? ' job' : ' jobs') : '';
    var list = $('queueList'); list.replaceChildren();
    if (!shown.length) {
      list.append(h('div', { class: 'empty' }, h('b', { text: jobs.length ? 'No jobs match' : 'The queue is empty' }),
        jobs.length ? 'Change the status, search or filters above.' : 'New requests from students appear here as they are sent. Express jobs come first, then the earliest due date.'));
      return;
    }
    var ul = h('ul', { class: 'jobs' });
    shown.forEach(function (j) {
      var info = statusInfo(j.ref), due = dueLabel(j.due), busy = ui.busy.has(j.ref), link = safeLink(j.link), fu = fileUrl(j.fileId);
      var isOpen = OPEN.indexOf(info.status) >= 0, dr = getDraft(j.ref, info);
      function move(to) {
        return async function () {
          var price = null;
          if (dr.price !== '') { price = Number(dr.price); if (!isFinite(price) || price < 0) { toast('Enter the final price as a number, for example 45 or 52.5.', 'bad'); return; } }
          ui.busy.add(j.ref); renderQueue();
          try {
            await setStatus(j.ref, to, to === 'rejected' ? (ui.rejecting.get(j.ref) || '').trim() || 'No reason given.' : dr.note.trim(), price);
            ui.rejecting.delete(j.ref); ui.collecting.delete(j.ref);
            toast(j.ref + ' is now ' + STATUS[to].toLowerCase() + '.', 'ok');
          } catch (e) { toast('Could not update ' + j.ref + '. Check your connection and try again.', 'bad'); }
          ui.busy.delete(j.ref); renderQueue();
        };
      }
      var btns = [];
      if (NEXT[info.status]) btns.push(h('button', { class: 'btn small primary', type: 'button', disabled: busy, onclick: move(NEXT[info.status][0]) }, NEXT[info.status][1]));
      if (info.status === 'ready') btns.push(h('button', { class: 'btn small primary', type: 'button', disabled: busy, onclick: function () { if (ui.collecting.has(j.ref)) ui.collecting.delete(j.ref); else ui.collecting.set(j.ref, ''); renderQueue(); } }, 'Hand over'));
      if (isOpen) {
        btns.push(h('button', { class: 'btn small', type: 'button', 'aria-expanded': String(dr.open), onclick: function () { dr.open = !dr.open; renderQueue(); } }, 'Note and price'));
        btns.push(h('button', { class: 'btn small danger', type: 'button', disabled: busy, onclick: function () { if (ui.rejecting.has(j.ref)) ui.rejecting.delete(j.ref); else ui.rejecting.set(j.ref, ''); renderQueue(); } }, 'Reject'));
      } else {
        btns.push(h('button', { class: 'btn small', type: 'button', disabled: busy, onclick: move('received') }, 'Reopen'));
      }
      var kids = [
        h('div', { class: 'job-main' },
          h('div', { class: 'job-top' }, h('span', { class: 'ref', text: j.ref }), pill(info.status), h('span', { class: 'cat', text: catLabel(j) }), expressBadge(j),
            h('span', { class: 'due' + (due.late && isOpen ? ' late' : ''), text: due.text })),
          h('div', { class: 'job-title', text: j.title }),
          h('div', { class: 'meta', text: [j.name, j.roll, j.dept].filter(Boolean).join(' · ') }),
          h('div', { class: 'meta', text: specLine(j) }),
          j.notes ? h('div', { class: 'meta', text: 'Student note: ' + j.notes }) : null,
          info.note ? h('div', { class: 'meta', text: 'Shop note: ' + info.note }) : null,
          fu ? h('div', { class: 'meta' }, h('a', { href: fu, target: '_blank', rel: 'noopener noreferrer', text: 'Open uploaded file' + (j.fileName ? ' (' + j.fileName + ')' : '') })) : null,
          link ? h('div', { class: 'meta' }, h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: 'Open file link' })) : null,
          !fu && !link ? h('div', { class: 'meta', text: 'No file attached. The student will bring it.' }) : null),
        h('div', { class: 'job-side' }, h('span', { class: 'money', text: money(priceOf(j)) }), h('div', { class: 'job-btns' }, btns))
      ];
      if (isOpen && dr.open) {
        kids.push(h('div', { class: 'sub-box' },
          h('div', { class: 'field' }, h('label', { class: 'lab', for: 'note-' + j.ref, text: 'Note for the student' }),
            h('input', { type: 'text', id: 'note-' + j.ref, value: dr.note, placeholder: 'e.g. Spiral binding ready, pay at counter', oninput: function (e) { dr.note = e.target.value; } })),
          h('div', { class: 'field narrow' }, h('label', { class: 'lab', for: 'price-' + j.ref, text: 'Final price (₹)' }),
            h('input', { type: 'number', id: 'price-' + j.ref, min: '0', step: '0.5', value: dr.price, placeholder: String(Math.round((Number(j.estimate) || 0) * 100) / 100), oninput: function (e) { dr.price = e.target.value; } })),
          h('button', { class: 'btn small', type: 'button', disabled: busy, onclick: move(info.status) }, 'Save note and price')));
      }
      if (ui.collecting.has(j.ref)) {
        kids.push(h('div', { class: 'sub-box' },
          h('div', { class: 'field narrow' }, h('label', { class: 'lab', for: 'pin-' + j.ref, text: 'Pickup PIN from the student' }),
            h('input', { type: 'text', id: 'pin-' + j.ref, inputmode: 'numeric', maxlength: '4', autocomplete: 'off', value: ui.collecting.get(j.ref), placeholder: '4 digits', class: 'pininput', oninput: function (e) { ui.collecting.set(j.ref, e.target.value); e.target.removeAttribute('aria-invalid'); } })),
          h('button', { class: 'btn small primary', type: 'button', disabled: busy, onclick: function () {
            var typed = (ui.collecting.get(j.ref) || '').trim();
            if (j.pin && typed !== String(j.pin)) {
              var inp = $('pin-' + j.ref); if (inp) { inp.setAttribute('aria-invalid', 'true'); inp.focus(); }
              toast('That PIN does not match ' + j.ref + '. Ask the student to open My requests and read out the 4-digit PIN.', 'bad'); return;
            }
            move('collected')();
          } }, 'Confirm handover'),
          h('button', { class: 'btn small', type: 'button', disabled: busy, onclick: move('collected') }, 'Hand over without PIN (ID checked)')));
      }
      if (ui.rejecting.has(j.ref)) {
        kids.push(h('div', { class: 'sub-box' },
          h('div', { class: 'field' }, h('label', { class: 'lab', for: 'rej-' + j.ref, text: 'Reason shown to the student' }),
            h('input', { type: 'text', id: 'rej-' + j.ref, value: ui.rejecting.get(j.ref), placeholder: 'e.g. File link is private. Share it and send again.', oninput: function (e) { ui.rejecting.set(j.ref, e.target.value); } })),
          h('button', { class: 'btn small danger', type: 'button', disabled: busy, onclick: move('rejected') }, 'Confirm reject')));
      }
      ul.append(h('li', { class: 'job' }, kids));
    });
    list.append(ul);
  }
  $('qSearch').addEventListener('input', function (e) { ui.q.text = e.target.value.trim(); renderQueue(); });
  [['qCat', 'cat'], ['qPaper', 'paper'], ['qColour', 'colour'], ['qPrio', 'prio'], ['qSort', 'sort']].forEach(function (p) {
    $(p[0]).addEventListener('change', function (e) { ui.q[p[1]] = e.target.value; renderQueue(); });
  });
  $('qReset').addEventListener('click', function () {
    ui.q = { text: '', cat: 'all', paper: 'all', colour: 'all', prio: 'all', sort: 'due' }; ui.filter = 'open';
    $('qSearch').value = ''; $('qCat').value = 'all'; $('qPaper').value = 'all'; $('qColour').value = 'all'; $('qPrio').value = 'all'; $('qSort').value = 'due';
    renderQueue();
  });

  /* ---------- CSV export (staff) ---------- */
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // stop spreadsheet formula injection from student text
    return '"' + s.replace(/"/g, '""') + '"';
  }
  $('exportBtn').addEventListener('click', function () {
    var jobs = ui.lastShown || [];
    if (!state.dl) { toast('Export is not available in this view.', 'bad'); return; }
    if (!jobs.length) { toast('Nothing to export. Change the filters first.', 'bad'); return; }
    var head = ['Request number', 'Submitted', 'Name', 'Roll or staff ID', 'Department', 'Type', 'Document', 'Pages', 'Copies', 'Paper', 'Colour', 'Sides', 'GSM', 'Binding', 'Priority', 'Due', 'Status', 'Estimate (INR)', 'Final price (INR)'];
    var rows = jobs.map(function (j) {
      var info = statusInfo(j.ref);
      return [j.ref, j.createdAt, j.name, j.roll, j.dept, catLabel(j), j.title, j.pages, j.copies, j.paper, colourName(j.colour), j.sides === 'double' ? 'Double' : 'Single', j.gsm, j.binding, isExpress(j) ? 'Express' : 'Standard', j.due, STATUS[info.status], Number(j.estimate) || 0, info.price == null ? '' : info.price];
    });
    var data = '﻿' + [head].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    state.dl.save({ filename: 'print-queue-' + ymd(new Date()) + '.csv', data: data }).then(function () {
      toast('Exported ' + jobs.length + (jobs.length === 1 ? ' job.' : ' jobs.'), 'ok');
    }, function (e) {
      var c = e && e.code;
      if (c === 'declined') toast('Export cancelled.', 'bad');
      else if (c === 'unavailable' || c === 'not_granted' || c === 'capability_disabled' || c === 'capability_removed') toast('Export is not available in this view.', 'bad');
      else toast('The export could not be saved. Try again.', 'bad');
    });
  });

  /* ---------- dashboard ---------- */
  function barRows(rows) {
    var max = Math.max.apply(null, [1].concat(rows.map(function (r) { return r.value; })));
    return rows.map(function (r) {
      var fill = h('div', { class: 'bf', title: r.label + ': ' + r.value });
      fill.style.width = (r.value / max * 100) + '%';
      if (r.color) fill.style.background = r.color;
      return h('div', { class: 'brow' + (r.value === 0 ? ' zero' : ''), role: 'img', 'aria-label': r.label + ': ' + r.value },
        h('span', { class: 'bl', text: r.label }), h('div', { class: 'bt' }, fill), h('span', { class: 'bv', text: String(r.value) }));
    });
  }
  function chartPanel(title, sub, body) { return h('div', { class: 'panel chart' }, h('h3', { text: title }), h('p', { class: 'sub', text: sub }), body); }
  function renderDashboard() {
    var jobs = allJobs(), byStatus = { received: 0, printing: 0, ready: 0, collected: 0, rejected: 0 };
    var toPrint = [], sheets = 0, dueNow = 0, openVal = 0, collectedVal = 0, collectedN = 0, expressOpen = 0, spans = [];
    jobs.forEach(function (j) {
      var info = statusInfo(j.ref), s = info.status; byStatus[s]++;
      if (s === 'received' || s === 'printing') {
        toPrint.push(j);
        sheets += calc({ pages: j.pages, copies: j.copies, sides: j.sides, paper: j.paper, colour: j.colour, gsm: j.gsm, binding: j.binding }).sheets;
        if (daysFromToday(j.due) <= 0) dueNow++;
      }
      if (OPEN.indexOf(s) >= 0) { openVal += priceOf(j); if (isExpress(j)) expressOpen++; }
      if (s === 'collected') {
        collectedN++; collectedVal += priceOf(j);
        var done = info.history.filter(function (x) { return x.s === 'collected'; }).pop();
        if (done && j.createdAt) { var ms = Date.parse(done.at) - Date.parse(j.createdAt); if (isFinite(ms) && ms >= 0) spans.push(ms); }
      }
    });
    var avg = spans.length ? fmtSpan(spans.reduce(function (a, b) { return a + b; }, 0) / spans.length) : 'No data';
    $('dashStats').replaceChildren(
      stat('Open jobs', byStatus.received + byStatus.printing + byStatus.ready, 'Not yet collected'),
      stat('Due today or late', dueNow, 'Still to print', dueNow > 0),
      stat('Express open', expressOpen, 'Printed first'),
      stat('Ready to collect', byStatus.ready, 'Waiting at the counter'),
      stat('Sheets to print', sheets, 'About ' + fmtMin(Math.ceil(sheets / state.settings.ppm)) + ' of work'),
      stat('Avg. turnaround', avg, spans.length + (spans.length === 1 ? ' collected job' : ' collected jobs')),
      stat('Collected', money(collectedVal), collectedN + (collectedN === 1 ? ' job' : ' jobs') + ', ' + money(openVal) + ' still open'));

    var statusRows = ['received', 'printing', 'ready', 'collected', 'rejected'].map(function (s) { return { label: STATUS[s], value: byStatus[s], color: 'var(--s-' + s + ')' }; });
    var buckets = [0, 0, 0, 0, 0, 0, 0, 0], labels = ['Late'];
    for (var i = 0; i < 7; i++) { var d = new Date(); d.setDate(d.getDate() + i); labels.push(i === 0 ? 'Today' : d.toLocaleDateString('en-IN', { weekday: 'short' }) + ' ' + d.getDate()); }
    toPrint.forEach(function (j) { var n = daysFromToday(j.due); if (isNaN(n)) return; if (n < 0) buckets[0]++; else if (n <= 6) buckets[n + 1]++; });
    var maxB = Math.max.apply(null, [1].concat(buckets)), cols = h('div', { class: 'cols' });
    buckets.forEach(function (n, k) {
      var bar = h('div', { class: 'cb', title: labels[k] + ': ' + n });
      bar.style.height = n === 0 ? '2px' : (n / maxB * 100) + '%';
      cols.append(h('div', { class: 'col' + (k === 0 ? ' late' : ''), role: 'img', 'aria-label': labels[k] + ': ' + n + ' jobs' }, h('span', { class: 'cv', text: String(n) }), bar, h('span', { class: 'cl', text: labels[k] })));
    });
    var catCounts = {}; jobs.forEach(function (j) { var c = CAT[j.category] ? j.category : 'other'; catCounts[c] = (catCounts[c] || 0) + 1; });
    var catRows = CATEGORIES.map(function (c) { return { label: c[1], value: catCounts[c[0]] || 0 }; });
    function cnt(fn) { return jobs.filter(fn).length; }
    var mix = h('div', {},
      h('div', { class: 'grp', text: 'Paper size' }), barRows(['A5', 'A4', 'A3'].map(function (p) { return { label: p, value: cnt(function (j) { return j.paper === p; }) }; })),
      h('div', { class: 'grp', text: 'Colour mode' }), barRows([['bw', 'Black & white'], ['colour', 'Colour']].map(function (c) { return { label: c[1], value: cnt(function (j) { return j.colour === c[0]; }) }; })),
      h('div', { class: 'grp', text: 'Priority' }), barRows([['standard', 'Standard'], ['express', 'Express']].map(function (c) { return { label: c[1], value: cnt(function (j) { return (isExpress(j) ? 'express' : 'standard') === c[0]; }) }; })));
    $('dashCharts').replaceChildren(
      chartPanel('Jobs by status', 'All jobs the shop has received.', h('div', {}, barRows(statusRows))),
      chartPanel('Still to print, by due date', 'Late jobs first, then the next seven days.', cols),
      chartPanel('By type of document', 'Where the demand is coming from.', h('div', {}, barRows(catRows))),
      chartPanel('Paper, colour and priority', 'What the printers will be loaded with.', mix));

    var late = toPrint.filter(function (j) { return daysFromToday(j.due) <= 0; }).sort(byDue).slice(0, 6);
    var at = $('dashAttention'); at.replaceChildren();
    at.append(h('div', { class: 'job', style: 'align-items:center' }, h('div', {}, h('h2', { text: 'Needs attention' }), h('p', { class: 'sub', style: 'margin:0', text: 'Jobs due today or already late and not yet printed.' })),
      h('a', { class: 'btn small', href: '#queue', onclick: function () { ui.filter = 'open'; } }, 'Open the queue')));
    if (!late.length) { at.append(h('div', { class: 'empty', style: 'border-top:1px solid var(--line)' }, h('b', { text: 'Nothing is late' }), 'Every job still to print has a due date after today.')); return; }
    var ul = h('ul', { class: 'jobs' });
    late.forEach(function (j) {
      var info = statusInfo(j.ref), due = dueLabel(j.due);
      ul.append(h('li', { class: 'job' }, h('div', { class: 'job-main' },
        h('div', { class: 'job-top' }, h('span', { class: 'ref', text: j.ref }), pill(info.status), expressBadge(j), h('span', { class: 'due late', text: due.text })),
        h('div', { class: 'job-title', text: j.title }), h('div', { class: 'meta', text: [j.name, j.roll].filter(Boolean).join(' · ') + ' · ' + specLine(j) }))));
    });
    at.append(ul);
  }

  /* ---------- settings (staff) ---------- */
  function buildSettings(src) {
    var S = src || state.settings, body = $('setBody'); body.replaceChildren();
    ui.setBuilt = true; ui.setDirty = false; ui.setSeen = state.setVersion; $('setError').hidden = true;
    function mark() { ui.setDirty = true; }
    function ni(id, val, label, step, max) { return h('input', { type: 'number', id: id, min: '0', max: max, step: step || '0.25', value: String(val), inputmode: 'decimal', 'aria-label': label, oninput: mark }); }
    function grid(cols, rows) {
      var g = h('div', { class: 'rategrid', style: 'grid-template-columns:minmax(80px,120px) repeat(' + cols + ', minmax(90px,160px))' });
      rows.forEach(function (r) { r.forEach(function (c) { g.append(c); }); });
      return g;
    }
    var statusField = h('div', { class: 'field' }, h('span', { class: 'lab', id: 'lab-open', text: 'Taking new requests' }),
      h('div', { class: 'opts', role: 'radiogroup', 'aria-labelledby': 'lab-open' },
        ['open', 'paused'].map(function (v) {
          return h('label', { class: 'chip' }, h('input', { type: 'radio', name: 'setopen', value: v, checked: (v === 'open') === S.open, onchange: mark }), h('span', { text: v === 'open' ? 'Open' : 'Paused' }));
        })));
    var noticeField = h('div', { class: 'field' }, h('label', { class: 'lab', for: 'set-notice', text: 'Notice for students (optional)' }),
      h('input', { type: 'text', id: 'set-notice', maxlength: '200', value: S.notice, placeholder: 'e.g. Counter closes at 4 pm today. Printer 2 is down.', oninput: mark }));
    body.append(h('fieldset', {}, h('legend', { text: 'Shop status' }), h('div', { class: 'row' }, statusField), h('div', { class: 'row' }, noticeField)));

    var head = [h('span', {}), h('span', { class: 'gh', text: 'Black & white' }), h('span', { class: 'gh', text: 'Colour' })];
    var sideRows = [head].concat(['A5', 'A4', 'A3'].map(function (p) {
      return [h('span', { class: 'gl', text: p }), ni('set-side-' + p + '-bw', S.rates.side[p].bw, p + ' black and white rate'), ni('set-side-' + p + '-colour', S.rates.side[p].colour, p + ' colour rate')];
    }));
    body.append(h('fieldset', {}, h('legend', { text: 'Price per printed side (₹)' }), grid(2, sideRows)));

    var gsmRows = ['70', '80', '100'].map(function (g) { return [h('span', { class: 'gl', text: g + ' GSM' }), ni('set-gsm-' + g, S.rates.gsm[g], g + ' GSM surcharge per sheet')]; });
    var bindRows = ['None', 'Staple', 'Spiral', 'Thermal'].map(function (b) { return [h('span', { class: 'gl', text: b }), ni('set-bind-' + b, S.rates.bind[b], b + ' binding per copy')]; });
    body.append(h('fieldset', {}, h('legend', { text: 'Paper weight surcharge (₹ per sheet) and binding (₹ per copy)' }),
      h('div', { class: 'two' }, grid(1, gsmRows), grid(1, bindRows))));

    body.append(h('fieldset', {}, h('legend', { text: 'Express and speed' }), h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', { class: 'lab', for: 'set-express', text: 'Express surcharge per job (₹)' }), ni('set-express', S.expressFee, 'Express surcharge', '1', '1000'),
        h('div', { class: 'hint', text: 'Added to the price. Express jobs are printed first.' })),
      h('div', { class: 'field' }, h('label', { class: 'lab', for: 'set-ppm', text: 'Sheets finished per minute' }), ni('set-ppm', S.ppm, 'Sheets per minute', '1', '200'),
        h('div', { class: 'hint', text: 'Include handling time. This drives the wait estimate students see.' })))));
  }
  function readSettings() {
    var bad = [], out = clone(DEFAULTS);
    function rd(id, label, max, min) {
      var el = $(id), raw = el.value.trim(), v = Number(raw);
      if (raw === '' || !isFinite(v) || v < (min || 0) || (max != null && v > max)) { bad.push(label); el.setAttribute('aria-invalid', 'true'); return null; }
      el.removeAttribute('aria-invalid'); return v;
    }
    ['A5', 'A4', 'A3'].forEach(function (p) { out.rates.side[p].bw = rd('set-side-' + p + '-bw', p + ' black and white'); out.rates.side[p].colour = rd('set-side-' + p + '-colour', p + ' colour'); });
    ['70', '80', '100'].forEach(function (g) { out.rates.gsm[g] = rd('set-gsm-' + g, g + ' GSM'); });
    ['None', 'Staple', 'Spiral', 'Thermal'].forEach(function (b) { out.rates.bind[b] = rd('set-bind-' + b, b + ' binding'); });
    out.expressFee = rd('set-express', 'Express surcharge', 1000);
    out.ppm = rd('set-ppm', 'Sheets per minute', 200, 1);
    var checked = document.querySelector('input[name="setopen"]:checked');
    out.open = !checked || checked.value === 'open';
    out.notice = $('set-notice').value.trim().slice(0, 200);
    return { bad: bad, value: out };
  }
  $('setForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var r = readSettings(), err = $('setError');
    if (r.bad.length) { err.textContent = 'Enter a number for: ' + r.bad.join(', ') + '. Rates cannot be negative and sheets per minute must be at least 1.'; err.hidden = false; return; }
    err.hidden = true;
    var btn = $('setSave'); btn.disabled = true; btn.textContent = 'Saving...';
    try {
      if (state.mode === 'db') await dbApi.doc('settings/shop').set(r.value);
      state.settings = r.value; ui.setDirty = false; ui.setSeen = state.setVersion; persistLocal();
      toast('Settings saved. Students see the new prices and notice now.', 'ok'); render();
    } catch (e) {
      err.textContent = e && e.code === 'invalid_argument' ? 'Only editors can change shop settings.' : 'The settings could not be saved. Check your connection and try again.'; err.hidden = false;
    }
    btn.disabled = false; btn.textContent = 'Save settings';
  });
  $('setReset').addEventListener('click', function () { buildSettings(clone(DEFAULTS)); ui.setDirty = true; toast('Default values loaded. Press Save settings to apply them.', 'ok'); });
  var wipeArmed = false;
  $('wipeLocal').addEventListener('click', function () {
    var b = $('wipeLocal');
    if (!wipeArmed) { wipeArmed = true; b.textContent = 'Click again to delete all demo data'; setTimeout(function () { wipeArmed = false; b.textContent = 'Clear demo data'; }, 5000); return; }
    wipeArmed = false; b.textContent = 'Clear demo data';
    state.localJobs = []; state.localStatuses = new Map(); state.settings = mergeSettings(null); ui.setBuilt = false;
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* nothing saved */ }
    toast('Demo data cleared.', 'ok'); render();
  });
  function renderSettings() { if (!ui.setBuilt || (!ui.setDirty && ui.setSeen !== state.setVersion)) buildSettings(); }

  /* ---------- chrome + routing ---------- */
  var VIEWS = ['request', 'track', 'dashboard', 'queue', 'settings'], STAFF_ONLY = ['dashboard', 'queue', 'settings'];
  function currentView() { var v = (location.hash || '').replace('#', ''); return VIEWS.indexOf(v) >= 0 ? v : 'request'; }
  function render() {
    var view = currentView(), staff = state.ready && state.isStaff, S = state.settings;
    $('tabQueue').hidden = !staff; $('tabDash').hidden = !staff; $('tabSet').hidden = !staff;
    document.querySelectorAll('.tabs a').forEach(function (a) { if (a.dataset.tab === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    VIEWS.forEach(function (v) { $('view-' + v).hidden = v !== view; });
    if (STAFF_ONLY.indexOf(view) >= 0 && state.ready && !state.isStaff) { location.hash = '#request'; return; }
    applyMode();
    if (view === 'track') renderTrack();
    if (view === 'dashboard') renderDashboard();
    if (view === 'queue') renderQueue();
    if (view === 'settings') renderSettings();
    var closed = !S.open && !state.isStaff;
    $('submitBtn').disabled = !state.canWrite || closed;
    $('formNote').textContent = closed ? 'The print desk is not taking new requests right now.'
      : !state.canWrite ? 'You can view this portal but not send requests. Ask the page owner to share it with you as a Contributor.'
      : 'The estimate is a guide. The counter confirms the final price when you collect.';
    $('wipeLocal').hidden = state.mode !== 'local';
    var notice = S.notice || (!S.open ? 'The print desk is paused and not taking new requests.' : '');
    $('shopNotice').textContent = notice; $('shopNotice').hidden = !notice;
    if (state.syncNote) say(state.syncNote);
    else if (state.ready && state.mode === 'local') say('Demo mode. Everything is saved in this browser only. Use the Print queue, Dashboard and Settings tabs to act as the print desk.');
    else say('');
  }
  window.addEventListener('hashchange', function () { render(); window.scrollTo(0, 0); });

  /* ---------- boot ---------- */
  (function setup() {
    fillSelect($('category'), CATEGORIES);
    fillSelect($('qCat'), [['all', 'All types']].concat(CATEGORIES));
    fillSelect($('myCat'), [['all', 'All types']].concat(CATEGORIES));
    fillSelect($('myStatus'), [['all', 'Any status'], ['open', 'Not collected yet']].concat(Object.keys(STATUS).map(function (k) { return [k, STATUS[k]]; })));
    $('due').min = ymd(new Date());
    clearJobFields(); $('fileField').hidden = true; render();
  })();

  (async function connect() {
    try {
      var db = window.claude && window.claude.use ? await window.claude.use('db') : null;
      if (!db) throw new Error('no db');
      var user = await window.claude.use('user');
      dbApi = db;
      state.uid = user ? await user.id() : null;
      state.isStaff = user ? await user.canEdit() : false;
      var cw = user ? await user.can('data.write') : null;
      state.canWrite = cw !== false;
      try { state.assets = await window.claude.use('assets'); } catch (e) { state.assets = null; }
      try { state.dl = state.isStaff ? await window.claude.use('downloads') : null; } catch (e) { state.dl = null; }
      state.mode = 'db';
      var loaded = { q: false, s: false, p: false, c: false };
      var timer = setTimeout(function () { state.syncNote = 'Cannot reach the request store yet. What you see may be out of date.'; render(); }, 10000);
      function arrived(k, snap) {
        if (snap.metadata.fromCache) return;
        loaded[k] = true;
        if (loaded.q && loaded.s && loaded.p && loaded.c) { clearTimeout(timer); if (state.syncNote) { state.syncNote = ''; render(); } }
      }
      function failed(e) { clearTimeout(timer); state.syncNote = e && e.code === 'revoked' ? '' : 'Live updates stopped. Reload the page to reconnect.'; render(); }
      db.collection('queue').onSnapshot(function (snap) {
        state.docs = new Map(snap.docs.map(function (d) { return [d.id, d.data()]; }));
        arrived('q', snap); render();
      }, failed);
      db.collection('pub').onSnapshot(function (snap) {
        state.pub = new Map(snap.docs.map(function (d) { return [d.id, d.data()]; }));
        arrived('p', snap); render();
      }, failed);
      db.doc('settings/shop').onSnapshot(function (snap) {
        state.settings = mergeSettings(snap.exists ? snap.data() : null); state.setVersion++;
        arrived('c', snap); render();
      }, failed);
      db.collection('status').onSnapshot(function (snap) {
        var next = new Map(snap.docs.map(function (d) { return [d.id, d.data()]; }));
        if (ui.notifyOn) {
          var mine = {}; myJobs().forEach(function (j) { mine[j.ref] = j; });
          next.forEach(function (s, ref) {
            var old = state.statuses.get(ref);
            if (!mine[ref] || !s || !STATUS[s.status] || (old && old.status === s.status)) return;
            if (!old && s.status === 'received') return;
            var msg = ref + ' is now ' + STATUS[s.status].toLowerCase() + '.';
            if (s.status === 'ready' && mine[ref].pin) msg += ' Your pickup PIN is ' + mine[ref].pin + '.';
            toast(msg, 'ok');
          });
        }
        state.statuses = next;
        if (!snap.metadata.fromCache) ui.notifyOn = true;
        arrived('s', snap); render();
      }, failed);
    } catch (e) {
      state.mode = 'local'; state.isStaff = true; state.canWrite = true; state.assets = null; state.dl = localDownloader; loadLocal();
    }
    state.ready = true;
    render();
  })();
})();
