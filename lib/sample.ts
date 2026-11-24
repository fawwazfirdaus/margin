import type { Post } from '../shared/contracts.ts';

type Sample = Post & { tags: string[] };
const studies: Omit<Sample, 'date'>[] = [
  { id:'sample-1', author:'Mira Ellis', handle:'margin_studio', body:'Two studies of the same tide. I kept the contour lines and changed the direction of the current.', tags:['printmaking'], media:[
    {type:'photo',src:'/media/tide.jpg',alt:'An indigo and cream relief print of long curling tidal currents'},
    {type:'photo',src:'/media/shore.jpg',alt:'A second tide study in ochre and charcoal'}] },
  { id:'sample-2', author:'Studio Forma', handle:'forma_notes', body:'A motion test from the print series. Watch the lines drift through a full cycle.', tags:['motion'], media:[
    {type:'video',src:'/media/drift.mp4',poster:'/media/drift.jpg',alt:'Moving contour lines in a tide study'}] },
  { id:'sample-3', author:'Nia Park', handle:'nia_collects', body:'A field note for the next project: keep one version of the sketch before you start refining it. Sometimes the first mark is the one you need.', tags:[], media:[],
    quoteId:'demo-quote-1',context:{checked:true,quotes:[
      {id:'demo-quote-1',author:'Studio Forma',handle:'forma_notes',date:'2026-10-20',body:'A proof can reveal the pressure of a pencil mark.',media:[],quoteId:'demo-quote-2'},
      {id:'demo-quote-2',author:'Mira Ellis',handle:'margin_studio',date:'2026-10-19',body:'A silverpoint drawing records even the faintest line.',media:[]}
    ],thread:[{id:'sample-3a',author:'Nia Park',handle:'nia_collects',date:'2026-10-22',body:'I keep a contact sheet of the early versions beside the finished print.',media:[]}]}
  },
  {id:'sample-4',author:'Margin Studio',handle:'margin_studio',body:'A page from the studio notebook.',tags:['printmaking'],
    media:[{type:'photo',src:'/media/field-note.png',alt:'A typeset notebook page'}]}
];

export const samples: Sample[] = studies.map((p,i) => ({ ...p, date:'2026-10-' + (24-i) + 'T12:00:00Z' }));
