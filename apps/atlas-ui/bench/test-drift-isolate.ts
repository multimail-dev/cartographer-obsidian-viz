/**
 * Isolate which optimization causes drift:
 * A) Grid only (no repulsion skip, no distant skip)
 * B) Grid + distant skip (no repulsion skip)
 * C) Grid + repulsion skip (no distant skip)
 * D) All optimizations (current FA3)
 */
import {
  buildMatrices, iterate, DEFAULT_SETTINGS,
  type FA3Settings, type NodeInput, type EdgeInput,
} from "../src/core/forceatlas3";

const PPN = 10;

function bruteForceIterate(o: FA3Settings, N: Float32Array, E: Float32Array): void {
  const order = N.length, size = E.length;
  for (let n = 0; n < order; n += PPN) { N[n+4]=N[n+2];N[n+5]=N[n+3];N[n+2]=0;N[n+3]=0; }
  const c = o.scalingRatio;
  for (let n1=0;n1<order;n1+=PPN) for (let n2=0;n2<n1;n2+=PPN) {
    const xd=N[n1]-N[n2],yd=N[n1+1]-N[n2+1],d2=xd*xd+yd*yd;
    if(d2>0){const f=(c*N[n1+6]*N[n2+6])/d2;N[n1+2]+=xd*f;N[n1+3]+=yd*f;N[n2+2]-=xd*f;N[n2+3]-=yd*f;}
  }
  const g=o.gravity/o.scalingRatio;
  if(o.strongGravityMode) for(let n=0;n<order;n+=PPN){const f=c*N[n+6]*g;N[n+2]-=N[n]*f;N[n+3]-=N[n+1]*f;}
  for(let e=0;e<size;e+=3){const n1=E[e],n2=E[e+1],w=E[e+2],xd=N[n1]-N[n2],yd=N[n1+1]-N[n2+1],f=-w;N[n1+2]+=xd*f;N[n1+3]+=yd*f;N[n2+2]-=xd*f;N[n2+3]-=yd*f;}
  for(let n=0;n<order;n+=PPN)if(N[n+9]!==1){
    const sw=N[n+6]*Math.sqrt((N[n+4]-N[n+2])**2+(N[n+5]-N[n+3])**2);
    const tr=Math.sqrt((N[n+4]+N[n+2])**2+(N[n+5]+N[n+3])**2)/2;
    const sp=(N[n+7]*Math.log(1+tr))/(1+Math.sqrt(sw));
    N[n+7]=Math.min(1,Math.sqrt((sp*(N[n+2]**2+N[n+3]**2))/(1+Math.sqrt(sw))));
    N[n]+=N[n+2]*(sp/o.slowDown);N[n+1]+=N[n+3]*(sp/o.slowDown);
  }
}

function pearsonDists(a: Float32Array, b: Float32Array, n: number): number {
  const da:number[]=[], db:number[]=[];
  const step=Math.max(1,Math.floor(n/30));
  for(let i=0;i<n;i+=step)for(let j=i+step;j<n;j+=step){
    const ax=a[i*PPN]-a[j*PPN],ay=a[i*PPN+1]-a[j*PPN+1];
    const bx=b[i*PPN]-b[j*PPN],by=b[i*PPN+1]-b[j*PPN+1];
    da.push(Math.sqrt(ax*ax+ay*ay));db.push(Math.sqrt(bx*bx+by*by));
  }
  let sa=0,sb=0,sab=0,sa2=0,sb2=0;
  for(let i=0;i<da.length;i++){sa+=da[i];sb+=db[i];sab+=da[i]*db[i];sa2+=da[i]*da[i];sb2+=db[i]*db[i];}
  const num=da.length*sab-sa*sb,den=Math.sqrt((da.length*sa2-sa*sa)*(da.length*sb2-sb*sb));
  return den===0?1:num/den;
}

const N=30;
const nodes:NodeInput[]=Array.from({length:N},(_,i)=>({
  x:Math.cos(2*Math.PI*i/N)*500+(Math.random()-0.5)*100,
  y:Math.sin(2*Math.PI*i/N)*500+(Math.random()-0.5)*100,size:5,
}));
const edges:EdgeInput[]=[];
for(let i=0;i<N;i++){edges.push({source:i,target:(i+1)%N,weight:1});if(i+3<N)edges.push({source:i,target:i+3,weight:0.5});}

const settings:FA3Settings={...DEFAULT_SETTINGS,scalingRatio:10,gravity:0.05,strongGravityMode:true,slowDown:1+Math.log(N)};

// We can't easily toggle FA3 internals, so let's test by reading the source code logic:
// The key question: what portion of drift comes from grid vs repulsion-skip vs distant-skip?

// Run brute-force as reference
const mRef = buildMatrices(nodes, edges);
const mRefE = new Float32Array(mRef.edges);

// Run FA3 (all opts)
const mAll = buildMatrices(nodes, edges);

for (let i = 0; i < 200; i++) {
  iterate(settings, mAll.nodes, mAll.edges, i);
  bruteForceIterate(settings, mRef.nodes, mRefE);
}
const corrAll = pearsonDists(mAll.nodes, mRef.nodes, N);

// Now test: what if we ONLY skip repulsion (no grid — just set iterationIndex to always trigger skip)?
// We can't control that from outside. But we can test the other direction:
// Run FA3 with iterationIndex always 0 (no skip, no distant skip, just grid)
const mGridOnly = buildMatrices(nodes, edges);
const mRefB = buildMatrices(nodes, edges);
const mRefBE = new Float32Array(mRefB.edges);
for (let i = 0; i < 200; i++) {
  iterate(settings, mGridOnly.nodes, mGridOnly.edges, 0); // always iter 0: no skip, no distant skip, exact reconcile
  bruteForceIterate(settings, mRefB.nodes, mRefBE);
}
const corrGridOnly = pearsonDists(mGridOnly.nodes, mRefB.nodes, N);

// Run with iterationIndex always even (no repulsion skip) but real iter count (has distant skip)
const mNoRepSkip = buildMatrices(nodes, edges);
const mRefC = buildMatrices(nodes, edges);
const mRefCE = new Float32Array(mRefC.edges);
for (let i = 0; i < 200; i++) {
  iterate(settings, mNoRepSkip.nodes, mNoRepSkip.edges, i * 2); // always even: no repulsion skip, but has distant skip
  bruteForceIterate(settings, mRefC.nodes, mRefCE);
}
const corrNoRepSkip = pearsonDists(mNoRepSkip.nodes, mRefC.nodes, N);

console.log("Correlation at iter 200:");
console.log(`  Grid only (no skips):            ${corrGridOnly.toFixed(6)}`);
console.log(`  Grid + distant skip (no rep skip): ${corrNoRepSkip.toFixed(6)}`);
console.log(`  All optimizations:               ${corrAll.toFixed(6)}`);
console.log(`\nDebt breakdown:`);
console.log(`  Grid approximation alone:    ${((1 - corrGridOnly) * 100).toFixed(2)}%`);
console.log(`  + distant skip adds:         ${((corrGridOnly - corrNoRepSkip) * 100).toFixed(2)}%`);
console.log(`  + repulsion skip adds:       ${((corrNoRepSkip - corrAll) * 100).toFixed(2)}%`);
console.log(`  Total debt:                  ${((1 - corrAll) * 100).toFixed(2)}%`);
