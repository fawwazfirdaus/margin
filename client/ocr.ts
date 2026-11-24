import type { PhotoJob, WordBox } from '../shared/discovery.js';
import {api,by,notice,problem} from './dom.js';
type Word={text:string;bbox:{x0:number;y0:number;x1:number;y1:number}};
interface Worker {recognize(image:HTMLCanvasElement,options:object,output:object):Promise<{data:{text:string;blocks?:{paragraphs:{lines:{words:Word[]}[]}[]}[]}}>;terminate():Promise<void>}
declare global {interface Window {Tesseract:{createWorker:(lang:string,oem:number,options:object)=>Promise<Worker>}}}
let script:Promise<void>|undefined;
function engine(){
  return script??=new Promise<void>((resolve,reject)=>{const s=document.createElement('script');s.src='/ocr/tesseract.min.js';s.onload=()=>resolve();s.onerror=()=>{script=undefined;reject(Error('Could not load the OCR engine.'));};document.head.append(s);});
}
export function installOCR(update:()=>Promise<void>){
  const start=by<HTMLButtonElement>('scan'),pause=by<HTMLButtonElement>('pause');
  let active=false,stop=false;
  pause.onclick=()=>{stop=true;pause.disabled=true;by('scan-note').textContent='Pausing after this image…';};
  by('retry-ocr').onclick=async()=>{try{await api('/api/discover/retry','POST');await update();}catch(e){problem(e);}};
  start.onclick=async()=>{
    if(active)return;active=true;stop=false;start.disabled=true;pause.hidden=false;pause.disabled=false;
    const limit=Number(by<HTMLSelectElement>('scan-limit').value);let completed=0,failed=0,w:Worker|undefined;
    try{
      await engine();w=await window.Tesseract.createWorker('eng',1,{workerPath:'/ocr/worker.min.js',workerBlobURL:false,corePath:'/ocr/core',langPath:'/ocr/lang'});
      while(!stop&&completed+failed<limit){
        const jobs=await api<PhotoJob[]>('/api/discover/jobs');if(!jobs.length)break;
        for(const job of jobs){
          if(stop||completed+failed>=limit)break;
          by('scan-note').textContent='Reading image '+(completed+failed+1)+'…';
          let result:{text?:string;words?:WordBox[];failed?:boolean};
          try{
            const r=await fetch('/api/discover/image?'+new URLSearchParams({id:job.id,slot:String(job.slot)}));if(!r.ok)throw Error('Image unavailable');
            const bitmap=await createImageBitmap(await r.blob());const scale=Math.min(1,2400/Math.max(bitmap.width,bitmap.height));
            const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
            canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
            const {data}=await w.recognize(canvas,{},{blocks:true,text:true});const words:WordBox[]=[];
            const clamp=(n:number)=>Math.min(1,Math.max(0,n));
            for(const block of data.blocks||[])for(const p of block.paragraphs)for(const l of p.lines)for(const word of l.words){
              const b=word.bbox;words.push([word.text,clamp(b.x0/canvas.width),clamp(b.y0/canvas.height),clamp(b.x1/canvas.width),clamp(b.y1/canvas.height)]);
            }
            result={text:data.text,words};canvas.width=canvas.height=1;
          }catch{result={failed:true};}
          await api('/api/discover/ocr','POST',{...job,...result});if(result.failed)failed++;else completed++;
          await update();
        }
      }
      by('scan-note').textContent=(stop?'Paused. ':'')+completed+' processed · '+failed+' failed in this run.';
    }catch(e){problem(e);by('scan-note').textContent='Scan stopped. Completed images are saved.';}
    finally{if(w)await w.terminate();active=false;start.disabled=false;pause.hidden=true;await update().catch(()=>notice('Refresh to update indexing progress.'));}
  };
}
