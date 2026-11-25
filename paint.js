const $ = id => document.getElementById(id);
const canvas = $('view'), ctx = canvas.getContext('2d', {willReadFrequently:true});
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
const small = document.createElement('canvas'), scan = small.getContext('2d',{willReadFrequently:true});
const strokes = [];
let tracker, stream, held = false, current, previousTime = -1;

// Pick the largest connected blob of each marker color, ignoring isolated pixels.
function corners() {
  small.width = 160;
  small.height = Math.round(160 * canvas.height / canvas.width);
  scan.drawImage(video,0,0,small.width,small.height);
  const {data} = scan.getImageData(0,0,small.width,small.height);
  const labels = new Uint8Array(data.length/4);
  for(let i=0;i<labels.length;i++) {
    const [r,g,b] = [data[4*i],data[4*i+1],data[4*i+2]];
    if(r>85 && r>1.6*g && r>1.6*b) labels[i]=1;
    else if(g>75 && g>1.5*r && g>1.5*b) labels[i]=2;
    else if(b>75 && b>1.5*r && b>1.5*g) labels[i]=3;
    else if(Math.min(r,g)>85 && Math.min(r,g)>1.7*b && Math.max(r,g)<1.45*Math.min(r,g)) labels[i]=4;
  }
  const best = Array(4).fill(null);
  for(let i=0;i<labels.length;i++) {
    const color = labels[i]; if(!color) continue;
    const queue=[i]; labels[i]=0;
    let sx=0,sy=0;
    for(let j=0;j<queue.length;j++){
      const p=queue[j], x=p%160, y=Math.floor(p/160); sx+=x;sy+=y;
      for(const n of [x?p-1:-1,x<159?p+1:-1,p-160,p+160]){
        if(labels[n]===color){labels[n]=0;queue.push(n);}
      }
    }
    const count=queue.length;
    if(count>=5 && count>(best[color-1]?.count||0)) best[color-1]={count,x:(sx/count+.5)*canvas.width/160,y:(sy/count+.5)*canvas.height/small.height};
  }
  if(best.some(p=>!p)) return null;
  const turns=best.map((a,i)=>{const b=best[(i+1)%4],c=best[(i+2)%4];return (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x)});
  return turns.every(t=>t>100)?best:null;
}

// Project the unit square onto the four dot centers with perspective.
function matrix([a,b,c,d]){
  const u=b.x-c.x,v=d.x-c.x,w=b.y-c.y,z=d.y-c.y;
  const dx=a.x-b.x+c.x-d.x,dy=a.y-b.y+c.y-d.y,det=u*z-v*w;
  const g=(dx*z-v*dy)/det,h=(u*dy-dx*w)/det;
  return [b.x-a.x+g*b.x,d.x-a.x+h*d.x,a.x,b.y-a.y+g*b.y,d.y-a.y+h*d.y,a.y,g,h];
}
function project([a,b,c,d,e,f,g,h],[x,y]){
  const k=g*x+h*y+1;return [(a*x+b*y+c)/k,(d*x+e*y+f)/k];
}
function unproject([a,b,c,d,e,f,g,h],[x,y]){
  const A=a-x*g,B=b-x*h,D=d-y*g,E=e-y*h,det=A*E-B*D;
  return [((x-c)*E-B*(y-f))/det,(A*(y-f)-(x-c)*D)/det];
}
function frame(){
  if(!stream)return;
  if(video.currentTime!==previousTime && video.readyState>=2){
    previousTime=video.currentTime;
    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    const dots=corners(),tip=tracker.detectForVideo(video,performance.now()).landmarks[0]?.[8];
    const m=dots && matrix(dots);
    if(m && tip && held){
      const p=unproject(m,[tip.x*canvas.width,tip.y*canvas.height]);
      if(p.every(Number.isFinite)){
        if(!current){current=[];strokes.push(current);}
        current.push(p);
      }
    }else current=null;
    if(m)for(const stroke of strokes){
      ctx.beginPath();ctx.strokeStyle='#ff66bb';ctx.lineWidth=5;ctx.lineCap='round';ctx.lineJoin='round';
      stroke.forEach((p,i)=>{const [x,y]=project(m,p);if(!i){ctx.moveTo(x-.1,y);};ctx.lineTo(x,y)});ctx.stroke();
    }
    if(tip){ctx.beginPath();ctx.arc(tip.x*canvas.width,tip.y*canvas.height,7,0,2*Math.PI);ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();}
    $('status').textContent=!dots?'Show all four marker dots':!tip?'Marker found · show your index finger':held?'Painting':'Ready · hold Paint to draw';
    $('undo').disabled=!strokes.length;
  }
  requestAnimationFrame(frame);
}
function release(){held=false;current=null;$('paint').classList.remove('active');}
$('paint').onpointerdown=e=>{e.preventDefault();$('paint').setPointerCapture(e.pointerId);held=true;$('paint').classList.add('active');};
$('paint').onlostpointercapture=release;
window.addEventListener('blur',release);
$('undo').onclick=()=>{release();strokes.pop();};
$('start').onclick=async()=>{
  $('start').disabled=true;$('status').textContent='Loading hand tracking…';
  try{
    const base='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304';
    const {FilesetResolver,HandLandmarker}=await import(base+'/vision_bundle.mjs');
    tracker=await HandLandmarker.createFromOptions(await FilesetResolver.forVisionTasks(base+'/wasm'),{baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'},runningMode:'VIDEO',numHands:1});
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:640},height:{ideal:480}},audio:false});
    video.srcObject=stream;await video.play();canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    $('paint').disabled=false;$('start').hidden=true;frame();
  }catch(error){stream?.getTracks().forEach(t=>t.stop());stream=null;tracker?.close();$('status').textContent='Could not start: '+error.message;$('start').disabled=false;}
};
