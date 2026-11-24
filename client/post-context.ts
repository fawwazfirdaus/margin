import type {Post,PostPart} from '../shared/contracts.js';
import type {Evidence} from '../shared/discovery.js';
import {el,marked} from './dom.js';

export function contextLabel(e:Evidence){
  if(e.source==='quote')return 'Quoted post · '+(e.author||'');
  if(e.source==='thread')return 'Author thread · '+(e.author||'');
  if(e.source==='post')return 'Post';
  return (e.source==='image'?'Text in image ':'Alt text · attachment ')+(e.slot+1);
}

export function contextReader(post:Post,terms:string[],demo:boolean) {
  const section=el('section','post-context');
  const quotes=new Map(post.context?.quotes.map(p=>[p.id,p]));
  function link(id:string){
    const a=el('a','textlink','View on X ↗');a.href='https://x.com/i/web/status/'+encodeURIComponent(id);
    a.target='_blank';a.rel='noopener';return a;
  }
  function card(p:PostPart,kind:string){
    const block=el('article','related-post');block.dataset.contextId=p.id;
    block.append(el('small','origin',kind),el('b','',p.author+(p.handle?' · @'+p.handle:'')));
    const text=el('p');text.append(marked(p.body,terms));block.append(text);
    for(const m of p.media){
      if(m.type==='photo'){const im=el('img');im.loading='lazy';im.src=m.src;im.alt=m.alt||'Attached photo';block.append(im);}
      else if(m.type!=='unavailable'&&m.src){const v=el('video');v.controls=true;v.playsInline=true;v.preload='none';v.src=m.src;if(m.poster)v.poster=m.poster;block.append(v);}
    }
    if(!demo)block.append(link(p.id));return block;
  }
  function appendQuotes(target:HTMLElement,id?:string){
    const seen=new Set([post.id]);let depth=0;
    while(id&&!seen.has(id)){
      seen.add(id);const p=quotes.get(id);
      if(!p){target.append(el('p','muted','Quoted post unavailable.'));if(!demo)target.append(link(id));break;}
      target.append(card(p,depth++?'Nested quote':'Quoted post'));id=p.quoteId;
    }
  }
  appendQuotes(section,post.quoteId);
  if(post.context?.thread.length){
    section.append(el('h3','','Author thread'));
    const ordered=[post,...post.context.thread].sort((a,b)=>a.id.length-b.id.length||a.id.localeCompare(b.id));
    ordered.forEach((p,i)=>{
      if(p.id===post.id){section.append(el('p','muted',(i+1)+' / '+ordered.length+' · This bookmark'));return;}
      const block=card(p,(i+1)+' / '+ordered.length);appendQuotes(block,p.quoteId);section.append(block);
    });
  }
  if(post.context?.warning)section.append(el('p','muted','Partial context. '+post.context.warning));
  return section;
}
