const $ = id => document.getElementById(id);
const canvas = $('view'), ctx = canvas.getContext('2d', {willReadFrequently:true});
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
const small = document.createElement('canvas'), scan = small.getContext('2d',{willReadFrequently:true});
const strokes = [];
let tracker, stream, current, previousTime = -1;

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
const colors = ['#ff66bb','#ff563f','#ffb52f','#ffe758','#46dc85','#38c8ff','#996dff','#ffffff'];
let color = colors[0];
let mode = 'idle';
let anchored = false;
let lastHandAt = -Infinity;

function resetBrush() {
  mode = 'idle';
  current = null;
}

// Measure bends in 3D so the gesture works with the hand turned sideways.
function handPose(hand) {
  const wrist = hand[0];
  const reach = p => Math.hypot(p.x-wrist.x, p.y-wrist.y, p.z-wrist.z);
  let curled = 0, extended = 0, indexExtended = false;
  for (const base of [5, 9, 13, 17]) {
    const a = hand[base], joint = hand[base+1], tip = hand[base+3];
    const u = [a.x-joint.x, a.y-joint.y, a.z-joint.z];
    const v = [tip.x-joint.x, tip.y-joint.y, tip.z-joint.z];
    const cosine = (u[0]*v[0]+u[1]*v[1]+u[2]*v[2]) / (Math.hypot(...u)*Math.hypot(...v));
    const folded = reach(tip) < reach(joint) * 1.04;
    if (cosine > -0.25 || folded) curled++;
    if (!folded && cosine < -0.65) {
      extended++;
      if (base === 5) indexExtended = true;
    }
  }
  if (curled >= 3 && !indexExtended) return 'closed';
  if (extended >= 2 && indexExtended) return 'open';
  return 'between';
}

function updateBrush(pose, markerVisible) {
  if (pose === 'closed') {
    current = null;
    mode = 'armed';
  } else if (mode === 'armed' && pose === 'open') {
    anchored = markerVisible;
    mode = 'painting';
  }
}

function drawPalette() {
  const top = canvas.height * 0.85, width = canvas.width / colors.length;
  colors.forEach((swatch,i) => {
    ctx.fillStyle = swatch;
    ctx.fillRect(i*width,top,width+1,canvas.height-top);
    if (swatch === color) {
      ctx.strokeStyle = '#14202a'; ctx.lineWidth = 4;
      ctx.strokeRect(i*width+4,top+4,width-8,canvas.height-top-8);
    }
  });
}

let mirrorPreview = true;

function displayX(cameraX) {
  return mirrorPreview ? 1 - cameraX : cameraX;
}

function frame(){
  if(!stream)return;
  if(video.currentTime!==previousTime && video.readyState>=2){
    previousTime=video.currentTime;
    ctx.save();
    if (mirrorPreview) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    ctx.restore();
    const dots = corners(), m = dots && matrix(dots);
    const result = tracker.detectForVideo(video,performance.now());
    const tip = result.landmarks[0]?.[8], hand = result.worldLandmarks?.[0] ?? result.landmarks[0];
    const inPalette = tip && tip.y >= 0.85 && tip.y <= 1 && tip.x >= 0 && tip.x <= 1;
    const now = performance.now();
    if (now - lastHandAt > 500) resetBrush();
    if (tip && hand) {
      lastHandAt = now;
      updateBrush(handPose(hand), Boolean(m));
    } else {
      current = null;
      if (mode === 'painting') resetBrush();
    }
    if (inPalette) color = colors[Math.min(colors.length-1,Math.floor(displayX(tip.x)*colors.length))];
    if((!anchored || m) && tip && !inPalette && mode === 'painting'){
      const p = anchored ? unproject(m,[tip.x*canvas.width,tip.y*canvas.height]) : [tip.x,tip.y];
      if(p.every(Number.isFinite)){
        if(!current){current={color,anchored,points:[]};strokes.push(current);}
        current.points.push(p);
      }
    }else current=null;
    for(const stroke of strokes){
      if(stroke.anchored && !m) continue;
      ctx.beginPath();ctx.strokeStyle=stroke.color;ctx.lineWidth=5;ctx.lineCap='round';ctx.lineJoin='round';
      stroke.points.forEach((p,i)=>{const [x,y]=stroke.anchored ? project(m,p) : [p[0]*canvas.width,p[1]*canvas.height];const screenX=displayX(x/canvas.width)*canvas.width;if(!i)ctx.moveTo(screenX-.1,y);ctx.lineTo(screenX,y)});ctx.stroke();
    }
    drawPalette();
    if(tip){
      ctx.beginPath();ctx.arc(displayX(tip.x)*canvas.width,tip.y*canvas.height,7,0,2*Math.PI);
      ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#19202a';ctx.lineWidth=2;ctx.stroke();
    }
    let hint = 'Make a fist to start';
    if (!tip) hint = 'Show your painting hand';
    else if (mode === 'armed') hint = 'Fist detected · open to paint';
    else if (inPalette) hint = 'Color selected · move above palette';
    else if (mode === 'painting') {
      hint = anchored && !m ? 'Paused · show marker again' :
        anchored ? 'Painting · anchored to marker' : 'Painting · screen canvas';
    }
    if ($('status').textContent !== hint) $('status').textContent = hint;
    $('undo').disabled=!strokes.length;
  }
  requestAnimationFrame(frame);
}
window.addEventListener('blur',resetBrush);
$('undo').onclick=()=>{resetBrush();strokes.pop();};
$('start').onclick=async()=>{
  $('start').disabled=true;$('status').textContent='Loading hand tracking…';
  try{
    const base='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304';
    const {FilesetResolver,HandLandmarker}=await import(base+'/vision_bundle.mjs');
    tracker=await HandLandmarker.createFromOptions(await FilesetResolver.forVisionTasks(base+'/wasm'),{baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'},runningMode:'VIDEO',numHands:1});
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'user'},width:{ideal:640},height:{ideal:480}},audio:false});
    mirrorPreview = stream.getVideoTracks()[0].getSettings().facingMode !== 'environment';
    video.srcObject=stream;await video.play();canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    $('start').hidden=true;frame();
  }catch(error){stream?.getTracks().forEach(t=>t.stop());stream=null;tracker?.close();$('status').textContent='Could not start: '+error.message;$('start').disabled=false;}
};
