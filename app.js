(() => {
  'use strict';

  // ---------- State ----------
  /** @type {{id:number, file:File, name:string, url:string, thumbUrl:string|null, w:number, h:number, rotation:number, key:string, taken:number|null}[]} */
  let items = [];
  let nextId = 1;
  let viewerIndex = -1;
  let dragId = null;
  const seen = new Set(); // fingerprints of pictures already in the list

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const fileInput = $('fileInput');
  const dropzone = $('dropzone');
  const workspace = $('workspace');
  const grid = $('grid');
  const bottombar = $('bottombar');
  const countEl = $('count');
  const addMoreBtn = $('addMoreBtn');
  const clearBtn = $('clearBtn');
  const convertBtn = $('convertBtn');

  const viewer = $('viewer');
  const viewerImg = $('viewerImg');
  const viewerWrap = viewerImg.parentElement;
  const filmstrip = $('filmstrip');

  const progress = $('progress');
  const progressFill = $('progressFill');
  const progressText = $('progressText');

  const done = $('done');
  const shareBtn = $('shareBtn');
  let pdfFile = null; // last generated PDF, as a File
  let pdfUrl = null;

  const isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches;
  const PICKER_LIMIT = 100; // Android's photo picker won't return more than this per selection
  let pending = 0;          // pictures still being prepared
  let pendingDone = 0;

  const toastEl = $('toast');
  let toastTimer = 0;
  function toast(msg, ms = 6000) {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.hidden = !msg;
    if (msg && ms) toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  // ---------- Helpers ----------
  const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|svg|ico|jfif|pjpeg|pjp)$/i;
  const isImage = (f) => (f.type && f.type.startsWith('image/')) || IMAGE_EXT.test(f.name);

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read image'));
      img.src = src;
    });
  }

  // Decode a picture for drawing. createImageBitmap can be closed right after use, which
  // frees the memory immediately — important when a phone handles hundreds of photos.
  async function decode(it) {
    if (window.createImageBitmap && navigator.userAgentData) { // Chromium: honours EXIF orientation like <img>
      try {
        const bmp = await createImageBitmap(it.file, { imageOrientation: 'from-image' });
        return { src: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
      } catch { /* fall back to <img> */ }
    }
    const img = await loadImage(it.url);
    return { src: img, width: img.naturalWidth, height: img.naturalHeight, close() { img.src = ''; } };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const findIndex = (id) => items.findIndex((it) => it.id === id);

  // ---------- Adding files ----------
  async function addFiles(fileList) {
    const images = Array.from(fileList).filter(isImage);
    const skipped = fileList.length - images.length;
    if (!images.length) {
      if (skipped) alert('None of those files are pictures.');
      return;
    }

    // Fingerprint each file and drop ones that are already in the list (or picked twice)
    const infos = await Promise.all(images.map(inspectFile));
    const files = [];
    let dupes = 0;
    infos.forEach((info) => {
      if (seen.has(info.key)) { dupes++; return; }
      seen.add(info.key);
      files.push(info);
    });
    if (!files.length) {
      toast(dupes === 1 ? 'That picture was already added — nothing new.' : `All ${dupes} pictures were already added — nothing new.`, 7000);
      return;
    }

    // Oldest photo first (date taken); fall back to natural name order so IMG_2 comes before IMG_10
    files.sort((a, b) => (a.taken && b.taken && a.taken - b.taken) ||
      a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' }));

    const added = files.map(({ file, key, taken }) => ({
      id: nextId++, file, key, taken, name: file.name,
      url: URL.createObjectURL(file), thumbUrl: null, w: 0, h: 0, rotation: 0,
    }));
    items.push(...added);
    pending += added.length;
    updatePending();
    render();

    // Build small thumbnails a few at a time so the page stays responsive
    const failed = [];
    const queue = added.slice();
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        try { await makeThumb(it); }
        catch { failed.push(it); }
        pendingDone++;
        updatePending();
        updateCardThumb(it);
      }
    };
    // Phones have less memory for decoding big camera photos, so do fewer at once
    await Promise.all(Array.from({ length: isTouch ? 2 : 4 }, worker));

    if (failed.length) {
      failed.forEach((it) => removeItem(it.id, true));
      render();
      const names = failed.slice(0, 8).map((f) => f.name).join('\n');
      const more = failed.length > 8 ? `\n…and ${failed.length - 8} more` : '';
      const heic = failed.some((f) => /\.hei[cf]$/i.test(f.name))
        ? '\n\nHEIC/HEIF photos are not supported by this browser. Set your camera to save as JPEG, or use Safari on iPhone.' : '';
      alert(`${failed.length} file(s) could not be opened and were skipped:\n\n${names}${more}${heic}`);
    } else if (dupes) {
      toast(`Added ${added.length} new picture${added.length === 1 ? '' : 's'} · skipped ${dupes} already added`, 7000);
    } else if (skipped) {
      toast(`${skipped} non-picture file(s) were ignored.`);
    } else if (isTouch && fileList.length === PICKER_LIMIT) {
      toast(`Added ${PICKER_LIMIT} pictures — that's the most the gallery allows at once. Tap “+ Add more” to add the rest.`, 9000);
    }
  }

  // Reads the start of a file: a content fingerprint (so the same photo is recognised even if
  // it comes from a different picker with a different name) and the EXIF "date taken".
  async function inspectFile(file) {
    let bytes;
    try { bytes = new Uint8Array(await file.slice(0, 131072).arrayBuffer()); }
    catch { return { file, key: `${file.name}|${file.size}`, taken: null }; }
    let h = 0x811c9dc5; // FNV-1a
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return { file, key: `${file.size}|${(h >>> 0).toString(36)}`, taken: readExifDate(bytes) };
  }

  function readExifDate(b) {
    try {
      if (b[0] !== 0xff || b[1] !== 0xd8) return null; // not a JPEG
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      let p = 2;
      while (p + 4 < b.length && b[p] === 0xff) {
        const marker = b[p + 1];
        const len = dv.getUint16(p + 2);
        if (marker === 0xe1 && dv.getUint32(p + 4) === 0x45786966) { // "Exif"
          const t = p + 10; // TIFF header
          const le = dv.getUint16(t) === 0x4949;
          const u16 = (o) => dv.getUint16(t + o, le);
          const u32 = (o) => dv.getUint32(t + o, le);
          const str = (o) => String.fromCharCode(...b.subarray(t + o, t + o + 19));
          const scan = (ifd, wanted) => {
            const n = u16(ifd);
            for (let i = 0; i < n; i++) {
              const e = ifd + 2 + i * 12;
              if (u16(e) === wanted) return u32(e + 8);
            }
            return null;
          };
          const ifd0 = u32(4);
          const exifIfd = scan(ifd0, 0x8769);
          const off = (exifIfd !== null && scan(exifIfd, 0x9003)) || scan(ifd0, 0x0132); // DateTimeOriginal, else DateTime
          if (!off) return null;
          const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(str(off));
          if (!m || m[1] === '0000') return null;
          return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        }
        if (marker === 0xda) break; // image data starts — no EXIF
        p += 2 + len;
      }
    } catch { /* malformed EXIF */ }
    return null;
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDate = (t) => dateFmt.format(new Date(t));

  // "Added so far" strip: helps find where you stopped in the phone's gallery
  function renderSummary() {
    const dated = items.filter((it) => it.taken).map((it) => it.taken);
    const el = $('summary');
    if (!items.length) { el.hidden = true; return; }
    el.hidden = false;
    const n = items.length;
    let html = `<strong>✓ ${n} picture${n === 1 ? '' : 's'} added</strong>`;
    if (dated.length) {
      const min = Math.min(...dated), max = Math.max(...dated);
      html += min === max
        ? `<span>Taken ${fmtDate(min)}</span>`
        : `<span>Newest: <b>${fmtDate(max)}</b></span><span>Oldest: <b>${fmtDate(min)}</b></span>`;
    }
    html += '<span class="muted">Pictures you already added are skipped automatically if you pick them again.</span>';
    el.innerHTML = html;
  }

  function updatePending() {
    if (pendingDone >= pending) {
      pending = pendingDone = 0;
      convertBtn.disabled = false;
      convertBtn.textContent = 'Convert to PDF';
      if (toastEl.dataset.loading) { toastEl.dataset.loading = ''; toast(''); }
      return;
    }
    convertBtn.disabled = true;
    convertBtn.textContent = `Preparing pictures… ${pendingDone} / ${pending}`;
    toastEl.dataset.loading = '1';
    toast(`Loading pictures ${pendingDone} / ${pending}…`, 0);
  }

  async function makeThumb(it) {
    const img = await decode(it);
    it.w = img.width;
    it.h = img.height;
    const max = 360;
    const s = Math.min(1, max / Math.max(it.w, it.h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(it.w * s));
    c.height = Math.max(1, Math.round(it.h * s));
    c.getContext('2d').drawImage(img.src, 0, 0, c.width, c.height);
    img.close();
    const blob = await canvasToBlob(c, 'image/jpeg', 0.8);
    c.width = c.height = 0;
    it.thumbUrl = blob ? URL.createObjectURL(blob) : it.url;
  }

  function removeItem(id, silent) {
    const i = findIndex(id);
    if (i < 0) return;
    const [it] = items.splice(i, 1);
    seen.delete(it.key); // removed pictures can be added again
    URL.revokeObjectURL(it.url);
    if (it.thumbUrl && it.thumbUrl !== it.url) URL.revokeObjectURL(it.thumbUrl);
    if (!silent) render();
  }

  function clearAll(skipConfirm) {
    if (!items.length || (!skipConfirm && !confirm('Remove all pictures?'))) return;
    [...items].forEach((it) => removeItem(it.id, true));
    closeViewer();
    render();
  }

  function rotate(id, delta) {
    const it = items[findIndex(id)];
    if (!it) return;
    // Keep a running total (not mod 360) so the CSS animation always turns the short way
    it.rotation += delta;
    const card = grid.querySelector(`[data-id="${id}"] .thumb img`);
    if (card) card.style.transform = `rotate(${it.rotation}deg)`;
    if (viewerIndex >= 0 && items[viewerIndex] === it) layoutViewerImage();
  }

  function move(id, delta) {
    const i = findIndex(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    render();
  }

  // ---------- Rendering ----------
  function render() {
    const n = items.length;
    countEl.textContent = `${n} image${n === 1 ? '' : 's'}`;
    renderSummary();
    dropzone.hidden = n > 0;
    workspace.hidden = bottombar.hidden = addMoreBtn.hidden = clearBtn.hidden = n === 0;

    const frag = document.createDocumentFragment();
    items.forEach((it, i) => frag.appendChild(buildCard(it, i)));
    grid.replaceChildren(frag);

    if (!viewer.hidden) {
      if (!n) closeViewer();
      else showInViewer(Math.min(viewerIndex, n - 1));
    }
  }

  function buildCard(it, i) {
    const card = document.createElement('div');
    card.className = 'card';
    card.draggable = true;
    card.dataset.id = it.id;
    card.innerHTML = `
      <div class="thumb" title="Click to view larger">
        ${it.thumbUrl ? `<img alt="" style="transform:rotate(${it.rotation}deg)">` : '<div class="loading"></div>'}
      </div>
      <span class="page-no">${i + 1}</span>
      <button class="remove" title="Remove" data-act="remove">✕</button>
      <div class="card-name"></div>
      <div class="card-tools">
        <button data-act="left" title="Move earlier" ${i === 0 ? 'disabled' : ''}>←</button>
        <button data-act="rotl" title="Rotate left">⟲</button>
        <button data-act="rotr" title="Rotate right">⟳</button>
        <button data-act="right" title="Move later" ${i === items.length - 1 ? 'disabled' : ''}>→</button>
      </div>`;
    // Phone pickers often give meaningless names, so show the date taken when we have it
    const label = card.querySelector('.card-name');
    label.textContent = it.taken ? fmtDate(it.taken) : it.name;
    label.title = it.name;
    const img = card.querySelector('.thumb img');
    if (img) img.src = it.thumbUrl;
    return card;
  }

  function updateCardThumb(it) {
    const thumb = grid.querySelector(`[data-id="${it.id}"] .thumb`);
    if (!thumb || !it.thumbUrl) return;
    const img = document.createElement('img');
    img.alt = '';
    img.style.transform = `rotate(${it.rotation}deg)`;
    img.src = it.thumbUrl;
    thumb.replaceChildren(img);
    filmstrip.querySelector(`[data-id="${it.id}"] img`)?.setAttribute('src', it.thumbUrl);
  }

  // Card button clicks / open viewer
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'remove') removeItem(id);
    else if (act === 'rotl') rotate(id, -90);
    else if (act === 'rotr') rotate(id, 90);
    else if (act === 'left') move(id, -1);
    else if (act === 'right') move(id, 1);
    else if (e.target.closest('.thumb')) openViewer(findIndex(id));
  });

  // ---------- Drag to reorder ----------
  function clearDropMarks() {
    grid.querySelectorAll('.drop-before, .drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
  }

  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    dragId = Number(card.dataset.id);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragId));
  });

  grid.addEventListener('dragend', () => {
    dragId = null;
    grid.querySelector('.dragging')?.classList.remove('dragging');
    clearDropMarks();
  });

  grid.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    const card = e.target.closest('.card');
    clearDropMarks();
    if (!card || Number(card.dataset.id) === dragId) return;
    const r = card.getBoundingClientRect();
    card.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
  });

  grid.addEventListener('drop', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.stopPropagation();
    const card = e.target.closest('.card');
    const target = card ? Number(card.dataset.id) : null;
    if (target !== null && target !== dragId) {
      const after = card.classList.contains('drop-after');
      const [moved] = items.splice(findIndex(dragId), 1);
      const ti = findIndex(target);
      items.splice(after ? ti + 1 : ti, 0, moved);
      render();
    }
    clearDropMarks();
  });

  // ---------- Dropping files from the computer ----------
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  let dragDepth = 0;

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (items.length) document.body.classList.add('dragging-files');
    else dropzone.classList.add('over');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging-files');
      dropzone.classList.remove('over');
    }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging-files');
    dropzone.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });

  // ---------- Pick files ----------
  const openPicker = () => fileInput.click();
  dropzone.addEventListener('click', openPicker);
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } });
  $('browseBtn').addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
  const pickers = { gallery: fileInput, files: $('filesInput'), camera: $('cameraInput') };
  for (const [name, btn] of [['gallery', 'galleryBtn'], ['files', 'filesBtn'], ['camera', 'cameraBtn']]) {
    $(btn).addEventListener('click', (e) => { e.stopPropagation(); pickers[name].click(); });
  }

  // On phones "+ Add more" offers gallery / files / camera
  const addSheet = $('addSheet');
  addMoreBtn.addEventListener('click', () => { if (isTouch) addSheet.hidden = false; else openPicker(); });
  addSheet.addEventListener('click', (e) => {
    const pick = e.target.closest('button')?.dataset.pick;
    if (!pick && e.target !== addSheet) return;
    addSheet.hidden = true;
    if (pickers[pick]) pickers[pick].click();
  });

  clearBtn.addEventListener('click', () => clearAll());
  for (const input of Object.values(pickers)) {
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = '';
    });
  }

  $('settingsToggle').addEventListener('click', (e) => {
    const open = $('settings').classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', open);
  });

  // ---------- Viewer ----------
  function openViewer(i) {
    if (i < 0) return;
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
    buildFilmstrip();
    showInViewer(i);
  }

  function closeViewer() {
    viewer.hidden = true;
    viewerIndex = -1;
    document.body.style.overflow = '';
  }

  function buildFilmstrip() {
    const frag = document.createDocumentFragment();
    items.forEach((it, i) => {
      const b = document.createElement('button');
      b.dataset.id = it.id;
      b.title = `${i + 1}. ${it.name}`;
      const img = document.createElement('img');
      img.alt = '';
      if (it.thumbUrl) img.src = it.thumbUrl;
      b.appendChild(img);
      b.addEventListener('click', () => showInViewer(findIndex(it.id)));
      frag.appendChild(b);
    });
    filmstrip.replaceChildren(frag);
  }

  function showInViewer(i) {
    if (i < 0 || i >= items.length) return;
    if (filmstrip.children.length !== items.length) buildFilmstrip();
    viewerIndex = i;
    const it = items[i];
    $('viewerCounter').textContent = `${i + 1} / ${items.length}`;
    $('viewerName').textContent = it.name;
    $('viewerPrev').disabled = i === 0;
    $('viewerNext').disabled = i === items.length - 1;

    Array.from(filmstrip.children).forEach((b, k) => b.classList.toggle('active', k === i));
    filmstrip.children[i]?.scrollIntoView({ block: 'nearest', inline: 'center' });

    if (viewerImg.dataset.id !== String(it.id)) {
      // Jump straight to the new rotation without animating from the previous picture's angle
      viewerImg.style.transition = 'none';
      viewerImg.dataset.id = it.id;
      viewerImg.src = it.url;
    }
    layoutViewerImage();
    requestAnimationFrame(() => { viewerImg.style.transition = ''; });
  }

  // Size the image so that it fits the stage *after* rotation
  function layoutViewerImage() {
    const it = items[viewerIndex];
    if (!it) return;
    const w = it.w || viewerImg.naturalWidth;
    const h = it.h || viewerImg.naturalHeight;
    if (!w || !h) { viewerImg.onload = layoutViewerImage; return; }
    const sideways = Math.abs(it.rotation / 90) % 2 === 1;
    const rw = sideways ? h : w;
    const rh = sideways ? w : h;
    const W = viewerWrap.clientWidth - 16;
    const H = viewerWrap.clientHeight - 16;
    const s = Math.min(1, W / rw, H / rh);
    viewerImg.style.maxWidth = 'none';
    viewerImg.style.maxHeight = 'none';
    viewerImg.style.width = `${w * s}px`;
    viewerImg.style.height = `${h * s}px`;
    viewerImg.style.transform = `rotate(${it.rotation}deg)`;
  }

  const viewerStep = (d) => showInViewer(viewerIndex + d);
  $('viewerPrev').addEventListener('click', () => viewerStep(-1));
  $('viewerNext').addEventListener('click', () => viewerStep(1));
  $('viewerClose').addEventListener('click', closeViewer);
  $('viewerRotL').addEventListener('click', () => rotate(items[viewerIndex].id, -90));
  $('viewerRotR').addEventListener('click', () => rotate(items[viewerIndex].id, 90));
  $('viewerDelete').addEventListener('click', () => {
    const it = items[viewerIndex];
    if (it) removeItem(it.id); // render() refreshes or closes the viewer
  });
  viewer.addEventListener('click', (e) => { if (e.target === viewerWrap || e.target.classList.contains('viewer-stage')) closeViewer(); });
  window.addEventListener('resize', () => { if (!viewer.hidden) layoutViewerImage(); });

  document.addEventListener('keydown', (e) => {
    if (viewer.hidden) return;
    if (e.key === 'ArrowLeft') viewerStep(-1);
    else if (e.key === 'ArrowRight') viewerStep(1);
    else if (e.key === 'Escape') closeViewer();
    else if (e.key.toLowerCase() === 'r') rotate(items[viewerIndex].id, e.shiftKey ? -90 : 90);
    else if (e.key.toLowerCase() === 'l') rotate(items[viewerIndex].id, -90);
    else return;
    e.preventDefault();
  });

  // Mouse wheel scrolls through pictures
  let wheelLock = 0;
  viewer.querySelector('.viewer-stage').addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - wheelLock < 250 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 10) return;
    wheelLock = now;
    viewerStep((e.deltaY || e.deltaX) > 0 ? 1 : -1);
  }, { passive: false });

  // Swipe on touch screens
  let touchX = null;
  viewerWrap.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  viewerWrap.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) viewerStep(dx < 0 ? 1 : -1);
    touchX = null;
  });

  // ---------- PDF ----------
  const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] }; // points
  const QUALITY = {
    low:    { maxDim: 1400, jpeg: 0.7 },
    medium: { maxDim: 2200, jpeg: 0.85 },
    high:   { maxDim: 3500, jpeg: 0.92 },
  };

  // Minimal PDF writer: each page is one JPEG. The JPEGs stay as Blobs (which the browser
  // can keep on disk) and are stitched into the final file, so memory use stays low even
  // for hundreds of pages on a phone.
  function createPdfWriter() {
    const parts = [];
    const offsets = [];
    const kids = [];
    let pos = 0;
    let nextObj = 3; // 1 = catalog, 2 = page tree
    const num = (n) => String(Math.round(n * 100) / 100);
    const push = (p) => { parts.push(p); pos += typeof p === 'string' ? p.length : (p.size ?? p.byteLength); };
    const obj = (n, ...body) => { offsets[n] = pos; push(`${n} 0 obj\n`); body.forEach(push); push('\nendobj\n'); };

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marks the file as binary

    return {
      addPage(jpeg, imgW, imgH, pw, ph, x, y, dw, dh) {
        const page = nextObj++, image = nextObj++, content = nextObj++;
        obj(image,
          `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB ` +
          `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.size} >>\nstream\n`, jpeg, '\nendstream');
        const draw = `q ${num(dw)} 0 0 ${num(dh)} ${num(x)} ${num(y)} cm /Im0 Do Q`;
        obj(content, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
        obj(page,
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}] ` +
          `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`);
        kids.push(page);
      },
      finish() {
        obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
        obj(2, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
        const xref = pos;
        let s = `xref\n0 ${nextObj}\n0000000000 65535 f \n`;
        for (let i = 1; i < nextObj; i++) s += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
        s += `trailer\n<< /Size ${nextObj} /Root 1 0 R /Info << /Producer (Images to PDF) >> >>\nstartxref\n${xref}\n%%EOF\n`;
        push(s);
        return new Blob(parts, { type: 'application/pdf' });
      },
    };
  }

  async function convert() {
    if (!items.length || pending) return;

    const pageSize = $('pageSize').value;
    const margin = Number($('margin').value);
    const q = QUALITY[$('quality').value];
    const name = $('fileName').value.trim().replace(/[\/:*?"<>|]+/g, '_').replace(/\.pdf$/i, '') || 'document';

    convertBtn.disabled = true;
    progress.hidden = false;
    setProgress(0, items.length);
    await tick();

    const pdf = createPdfWriter();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let img;
        try { img = await decode(it); }
        catch { throw new Error(`Could not read "${it.name}"`); }
        const w = img.width, h = img.height;
        const s = Math.min(1, q.maxDim / Math.max(w, h));
        const sw = Math.round(w * s), sh = Math.round(h * s);
        const rot = ((it.rotation % 360) + 360) % 360;
        const sideways = rot === 90 || rot === 270;

        // Draw the picture into a canvas, rotated
        canvas.width = sideways ? sh : sw;
        canvas.height = sideways ? sw : sh;
        ctx.fillStyle = '#fff'; // transparent PNGs get a white background
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(img.src, -sw / 2, -sh / 2, sw, sh);
        ctx.restore();
        img.close();
        const jpeg = await canvasToBlob(canvas, 'image/jpeg', q.jpeg);
        if (!jpeg) throw new Error(`Could not process "${it.name}"`);
        const cw = canvas.width, ch = canvas.height;

        // Work out the page size
        let pw, ph;
        if (pageSize === 'fit') {
          const k = 842 / Math.max(cw, ch); // roughly A4-sized, matching the picture's shape
          pw = cw * k + margin * 2;
          ph = ch * k + margin * 2;
        } else {
          const [a, b] = PAGE_SIZES[pageSize];
          const landscape = cw > ch;
          pw = landscape ? b : a;
          ph = landscape ? a : b;
        }

        // Centre the picture inside the margins
        const k = Math.min((pw - margin * 2) / cw, (ph - margin * 2) / ch);
        const dw = cw * k, dh = ch * k;
        pdf.addPage(jpeg, cw, ch, pw, ph, (pw - dw) / 2, (ph - dh) / 2, dw, dh);

        setProgress(i + 1, items.length);
        await tick();
      }
      progress.hidden = true;
      showDone(new File([pdf.finish()], `${name}.pdf`, { type: 'application/pdf' }));
    } catch (err) {
      console.error(err);
      alert(`Sorry, something went wrong while creating the PDF:\n${err.message}`);
    } finally {
      canvas.width = canvas.height = 0;
      convertBtn.disabled = false;
      progress.hidden = true;
    }
  }

  function showDone(file) {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfFile = file;
    pdfUrl = URL.createObjectURL(file);
    const mb = file.size / (1024 * 1024);
    const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    $('doneInfo').textContent = `${file.name} · ${items.length} page${items.length === 1 ? '' : 's'} · ${size}`;
    // Share sheet lets phones save straight to Files/Drive or send via WhatsApp, email, etc.
    shareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    done.hidden = false;
    $('downloadBtn').focus();
  }

  function hideDone() {
    done.hidden = true;
  }

  function downloadPdf() {
    if (!pdfFile) return;
    const a = document.createElement('a');
    a.href = pdfUrl;
    a.download = pdfFile.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  $('downloadBtn').addEventListener('click', downloadPdf);
  shareBtn.addEventListener('click', async () => {
    try { await navigator.share({ files: [pdfFile], title: pdfFile.name }); }
    catch (err) { if (err.name !== 'AbortError') downloadPdf(); }
  });
  $('doneBack').addEventListener('click', hideDone);
  $('doneNew').addEventListener('click', () => { hideDone(); clearAll(true); });
  done.addEventListener('click', (e) => { if (e.target === done) hideDone(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !done.hidden) hideDone(); });

  function setProgress(done, total) {
    const pct = Math.round((done / total) * 100);
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `Page ${done} of ${total} · ${pct}%`;
  }

  convertBtn.addEventListener('click', convert);

  render();
})();
