import type { VideoAttachment } from '../shared/contracts.js';

type Sources = Pick<VideoAttachment, 'src' | 'variants'>;
type Connection = { saveData?: boolean; downlink?: number; effectiveType?: string };

function connection(): Connection {
  return (navigator as Navigator & { connection?: Connection }).connection || {};
}

function conserveData(net: Connection) {
  return net.saveData || net.effectiveType === 'slow-2g' || net.effectiveType === '2g';
}

// The importer stores MP4 variants in descending bitrate order. Leave headroom for
// fluctuating throughput and cap the default quality for the inline reader.
function inlineSource(media: Sources, net: Connection) {
  if (!media.variants?.length) return media.src;
  const downlink = net.downlink ?? (net.effectiveType === '3g' ? 1 : 10);
  const budget = conserveData(net) ? 0 : Math.min(2_560_000, downlink * 650_000);
  return (media.variants.find(v => v.bitrate <= budget) || media.variants.at(-1))?.src || media.src;
}

function makePlayer(src: string, original: string | undefined, preload: HTMLVideoElement['preload']) {
  const player = document.createElement('video');
  player.preload = preload;
  player.playsInline = true;
  if (original && original !== src) {
    for (const url of [src, original]) {
      const source = document.createElement('source');
      source.src = url;
      source.type = 'video/mp4';
      player.append(source);
    }
  } else {
    player.src = src;
  }
  return player;
}

export function originalQuality(player: HTMLVideoElement) {
  const url = player.querySelector<HTMLSourceElement>('source:last-child')?.src;
  if (!url || !/^https?:\/\//.test(url)) return;
  const link = document.createElement('a');
  link.className = 'textlink';
  link.textContent = 'Original quality ↗';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

export function releaseVideo(video: HTMLVideoElement | null) {
  if (!video) return;
  video.pause();
  video.replaceChildren();
  video.removeAttribute('src');
  video.load(); // Abort outstanding range requests, including on detached elements.
}

export function videoLoader() {
  let staged: { src: string; original?: string; player: HTMLVideoElement } | undefined;
  let candidate: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connected = false;
  const touchList = matchMedia('(hover: none) and (pointer: coarse)').matches;
  const cards = new WeakMap<HTMLElement, Sources>();
  let visibleTimer: ReturnType<typeof setTimeout> | undefined;
  let visibleCard: HTMLElement | undefined;

  function endIntent() {
    clearTimeout(timer);
    clearTimeout(visibleTimer);
    visibleCard = undefined;
    candidate = undefined;
  }
  function clear() {
    endIntent();
    if (staged) releaseVideo(staged.player);
    staged = undefined;
  }
  function stage(media: Sources | undefined, preload: HTMLVideoElement['preload']) {
    const src = media && inlineSource(media, connection());
    if (!src || !media) { clear(); return; }
    if (staged?.src !== src || staged.original !== media.src || staged.player.error) {
      if (staged) releaseVideo(staged.player);
      const player = makePlayer(src, media.src, preload);
      staged = { src, original: media.src, player };
    } else {
      staged.player.preload = preload;
    }
  }

  function cancelIntent() {
    if (candidate) clear();
  }
  function scheduleVisible() {
    clearTimeout(visibleTimer);
    const net = connection();
    if (!touchList || document.hidden || conserveData(net) || net.effectiveType === '3g') return;
    if (visibleCard) {
      const rect = visibleCard.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight) clear();
    }
    visibleTimer = setTimeout(() => {
      if ((candidate && candidate !== visibleCard) || document.querySelector('dialog[open]')) return;
      // Hit-test the reading area. Scrolling through a long list never queues a batch.
      for (const fraction of [0.5, 0.7, 0.3]) {
        const card = document.elementFromPoint(innerWidth / 2, innerHeight * fraction)?.closest<HTMLElement>('.result');
        const media = card && cards.get(card);
        if (card && media) {
          if (visibleCard === card) return;
          visibleCard = candidate = card;
          stage(media, 'metadata');
          return;
        }
      }
      if (visibleCard) clear();
    }, 450);
  }
  function bind(button: HTMLElement, media: Sources) {
    if (!connected && media.src?.startsWith('https://video.twimg.com/') && !conserveData(connection())) {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = 'https://video.twimg.com';
      document.head.append(link);
      connected = true;
    }
    if (touchList) {
      cards.set(button, media);
      scheduleVisible();
    }
    function hint() {
      if (document.hidden || document.querySelector('dialog[open]') || conserveData(connection())) return;
      cancelIntent();
      candidate = button;
      timer = setTimeout(() => stage(media, 'metadata'), 180);
    }
    function leave() {
      if (candidate === button) clear();
    }
    button.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') hint(); });
    button.addEventListener('pointerdown', e => {
      if (!e.isPrimary || e.button !== 0 || conserveData(connection())) return;
      endIntent();
      candidate = button;
      stage(media, 'metadata');
    });
    button.addEventListener('pointercancel', leave);
    // Touch releases implicit capture before click, firing pointerleave even on a tap.
    button.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') leave(); });
    button.addEventListener('pointerup', e => {
      if (e.pointerType !== 'mouse' && candidate === button) timer = setTimeout(leave, 500);
    });
    button.addEventListener('contextmenu', leave);
    button.addEventListener('focus', () => { if (button.matches(':focus-visible')) hint(); });
    button.addEventListener('blur', leave);
  }

  function opening(media?: Sources) {
    endIntent();
    stage(media, conserveData(connection()) ? 'none' : 'auto');
  }
  function take(media: VideoAttachment, selected = true) {
    let video: HTMLVideoElement;
    if (selected) {
      opening(media); // Reconcile the search result with the current reader data.
      video = staged!.player;
      staged = undefined;
    } else {
      video = makePlayer(inlineSource(media, connection())!, media.src, 'none');
    }
    video.controls = true;
    if (media.poster) video.poster = media.poster;
    if (media.type === 'animated_gif') video.loop = video.muted = true;
    return video;
  }
  if (touchList) {
    document.addEventListener('scroll', scheduleVisible, { passive: true, capture: true });
    window.addEventListener('resize', scheduleVisible);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(visibleTimer);
      cancelIntent();
    } else if (touchList) scheduleVisible();
  });
  return { bind, opening, take, clear, cancelIntent };
}
