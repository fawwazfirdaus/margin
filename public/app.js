const $ = id => document.getElementById(id);
const views = { inbox:'Review queue', kept:'Kept', archive:'Archive', all:'All posts' };
let library, view = 'inbox', selected, mediaIndex = 0, query = '', editing, busy = false;

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(label, action, style) {
  const el = element('button',style,label);
  el.type = 'button';
  el.onclick = action;
  return el;
}
function notice(text) {
  $('status').hidden = !text;
  $('status').textContent = text;
}
async function api(path, method = 'GET', body) {
  const res = await fetch(path,{method,headers:body ? {'Content-Type':'application/json'} : {},body:body && JSON.stringify(body)});
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
async function load() {
  library = await api('/api/library');
  render();
}
function filtered() {
  const terms = query.toLowerCase().trim().split(/\s+/);
  return library.posts.filter(p => (view === 'all' || p.state === view) &&
    terms.every(t => [p.body, p.author, '@'+p.handle, ...p.tags].join(' ').toLowerCase().includes(t)));
}
function choose(id) {
  selected = id; mediaIndex = 0;
  render();
}
function source(post) {
  const link = element('a','source','View on X ↗');
  link.href = 'https://x.com/i/web/status/' + encodeURIComponent(post.id);
  link.target = '_blank'; link.rel = 'noopener';
  return link;
}
function showMedia(post) {
  const m = post.media[mediaIndex], figure = element('figure','visual');
  const missing = () => {
    if (figure.querySelector('.missing')) return;
    const msg = element('p','missing','This attachment is unavailable. ');
    if (!library.demo) msg.append(source(post));
    figure.prepend(msg);
  };
  if (m.src && ['photo','video','animated_gif'].includes(m.type)) {
    const visual = element(m.type === 'photo' ? 'img' : 'video');
    if (m.type === 'photo') visual.alt = m.alt || 'Bookmarked photo';
    else {
      visual.controls = true; visual.playsInline = true; visual.preload = 'metadata';
      if (m.poster) visual.poster = m.poster;
      if (m.type === 'animated_gif') { visual.loop = true; visual.muted = true; }
      visual.setAttribute('aria-label',m.alt || 'Bookmarked video');
    }
    visual.onerror = () => {visual.hidden = true; missing();};
    visual.src = m.src; figure.append(visual);
  } else {
    if (m.poster) {
      const poster = element('img'); poster.src=m.poster; poster.alt='Video preview'; figure.append(poster);
    }
    missing();
  }
  const pager = element('figcaption','pager');
  pager.append(element('span','',m.type === 'photo' ? 'Photograph' : m.type === 'animated_gif' ? 'Animated GIF' : m.type === 'video' ? 'Video' : 'Attachment'));
  if (post.media.length > 1) {
    const controls = element('span');
    const change = delta => { mediaIndex = (mediaIndex+delta+post.media.length)%post.media.length; render(); };
    const previous = button('←',()=>change(-1)), next = button('→',()=>change(1));
    previous.setAttribute('aria-label','Previous attachment'); next.setAttribute('aria-label','Next attachment');
    controls.append(previous,element('span','',(mediaIndex+1)+' / '+post.media.length),next);
    pager.append(controls);
  }
  figure.append(pager);
  return figure;
}
async function edit(id,data) {
  if (busy) return;
  busy = true;
  try {
    await api('/api/posts/'+encodeURIComponent(id),'PATCH',data);
    await load();
    notice(data.state ? 'Moved to '+views[data.state]+'.' : 'Tags saved.');
  } catch (e) { notice(e.message); }
  finally { busy = false; }
}
async function managePost(post) {
  if (busy) return;
  if (!library.canRemove) {
    if (!window.confirm('Enable bookmark removal for @'+library.name+'? After authorizing on X, select the post again to remove it.')) return;
    try { const {url}=await api('/auth/manage','POST'); location.assign(url); }
    catch (error) { notice(error.message); }
    return;
  }
  if (!window.confirm('Remove the bookmark by '+post.author+' from @'+library.name+' on X and from Margin?\n\n'+post.body.slice(0,140))) return;
  busy = true;
  try { await api('/api/posts/'+post.id,'DELETE'); await load(); notice('Bookmark removed from X and Margin.'); }
  catch (error) { notice(error.message); await load().catch(()=>{}); }
  finally {busy=false;}
}

async function loadPostMedia(post) {
  if (busy) return;
  busy = true;
  try {
    if (!library.connected) {
      const {url} = await api('/auth/start','POST'); location.assign(url); return;
    }
    await api('/api/posts/'+post.id+'/media','POST');
    mediaIndex=0; await load(); notice('Post refreshed from X.');
  } catch (error) { notice(error.message); await load().catch(()=>{}); }
  finally { busy=false; }
}

function drawPost(p) {
  const reader = $('reader');
  const by = element('div','byline'), who = element('div');
  const date = new Date(p.date);
  const when = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
  who.append(element('div','name',p.author),element('div','meta',[p.handle && '@'+p.handle,when].filter(Boolean).join(' · ')));
  by.append(element('span','avatar',p.author.slice(0,1)),who);
  if (!library.demo) by.append(source(p));
  reader.append(by,element('p','body',p.body));
  if (p.media.length) reader.append(showMedia(p));
  if (p.fromTimeline && !library.demo) reader.append(button('Load full post and media from X',()=>loadPostMedia(p),'subtle'));
  const tags = element('div','tools');
  for (const t of p.tags) tags.append(button('#'+t,() => { $('search').value=t; query=t; choose(null); },'chip'));
  tags.append(button('Edit tags',() => {
    editing=p.id; $('taginput').value=p.tags.join(', '); $('tags').showModal(); $('taginput').focus();
  },'subtle'));
  const actions = element('div','actions');
  if (p.state !== 'kept') actions.append(button('Keep',()=>edit(p.id,{state:'kept'}),'dark'));
  if (p.state !== 'archive') actions.append(button('Archive',()=>edit(p.id,{state:'archive'})));
  if (p.state !== 'inbox') actions.append(button('Return to queue',()=>edit(p.id,{state:'inbox'})));
  const list = filtered();
  if (list.length > 1) actions.append(button('Next →',()=>choose(list[(list.findIndex(v=>v.id===p.id)+1)%list.length].id),'subtle'));
  if (!library.demo) actions.append(button('Remove from X…',()=>managePost(p),'subtle'));
  reader.append(tags,actions);
}
function render() {
  $('account').textContent = library.demo ? 'Sample library' : '@'+library.name;
  $('connect').textContent = library.connected ? (library.resume ? 'Import next page' : 'Import from X') : (library.demo ? 'Connect X ↗' : 'Reconnect X ↗');
  $('signout').hidden = library.demo;
  $('callback').textContent = library.callback;
  $('title').textContent = views[view];
  $('views').replaceChildren();
  for (const [key,label] of Object.entries(views)) {
    const tab = button(label,() => { view=key; choose(null); });
    tab.append(element('span','count',String(key==='all' ? library.posts.length : library.posts.filter(p=>p.state===key).length)));
    tab.setAttribute('aria-current',view===key); $('views').append(tab);
  }
  const list = filtered();
  if (!list.some(p => p.id === selected)) {selected = list[0]?.id; mediaIndex = 0;}
  $('total').textContent = list.length+' '+(list.length===1?'post':'posts');
  $('queue').replaceChildren();
  for (const p of list) {
    const row = button('',()=>choose(p.id),'item');
    row.setAttribute('aria-current',p.id===selected);
    const m = p.media[0], preview = m?.type === 'photo' ? m.src : m?.poster;
    if (preview) {
      const thumb = element('img','thumb'); thumb.alt=''; thumb.loading='lazy'; thumb.src=preview; row.append(thumb);
    } else row.append(element('span','thumb textthumb','¶'));
    const info = element('span');
    info.append(element('strong','',p.author),element('span','snippet',p.body || 'Media post'));
    row.append(info); $('queue').append(row);
  }
  $('reader').replaceChildren();
  const p = list.find(p=>p.id===selected);
  if (p) drawPost(p);
  else {
    const empty = element('div','empty');
    empty.append(element('h2','',query ? 'No matching bookmarks' : 'Nothing here yet'),
      element('p','',query ? 'Try another author, phrase, or tag.' : !library.posts.length ? 'Import bookmarks from X to start reviewing.' :
        view==='inbox' ? 'Your review queue is clear.' : 'Bookmarks you move here will appear in this view.'));
    $('reader').append(empty);
  }
}
$('search').oninput = event => { query=event.target.value; choose(null); };
$('cancel').onclick = () => $('tags').close();
$('tagform').onsubmit = event => {
  event.preventDefault();
  const tags = $('taginput').value.split(',').map(t=>t.trim()).filter(Boolean);
  $('tags').close(); edit(editing,{tags});
};
$('signout').onclick = async () => {
  try { await api('/auth/signout','POST'); location.reload(); } catch(e) { notice(e.message); }
};
$('connect').onclick = async () => {
  const btn = $('connect');
  if (!library?.configured) { $('setup').showModal(); return; }
  btn.disabled = true;
  try {
    if (library.connected) {
      notice('Reading up to 20 bookmarks from X…');
      const result = await api('/api/sync','POST'); await load();
      notice(result.added+' new bookmarks. '+(result.more ? 'Choose Import next page to continue.' : 'X supplied no next page. Your X bookmark list may contain more posts.') +
        (result.partial ? ' X could not return some requested data.' : ''));
    } else {
      const {url} = await api('/auth/start','POST'); location.assign(url);
    }
  } catch(e) { notice(e.message); await load().catch(()=>{}); }
  finally {btn.disabled=false;}
};
const params = new URLSearchParams(location.search);
if (params.has('auth')) {
  notice(params.get('message') || (params.get('auth')==='expired' ? 'Connection expired. Try again.' : 'X connection cancelled.'));
  history.replaceState(null,'','/');
}
load().catch(e => notice(e.message));
