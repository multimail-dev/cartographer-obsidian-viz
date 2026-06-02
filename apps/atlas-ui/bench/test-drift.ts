/**
 * How far does the grid diverge from brute-force over many iterations?
 * Run both to 200 iterations, report correlation every 10.
 */
import {
  buildMatrices, iterate, DEFAULT_SETTINGS,
  type FA3Settings, type NodeInput, type EdgeInput,
} from "../src/core/forceatlas3";

const PPN = 10;

function bruteForceIterate(options: FA3Settings, N: Float32Array, E: Float32Array): void {
  const order = N.length, size = E.length;
  for (let n = 0; n < order; n += PPN) {
    N[n+4] = N[n+2]; N[n+5] = N[n+3]; N[n+2] = 0; N[n+3] = 0;
  }
  const c = options.scalingRatio;
  for (let n1 = 0; n1 < order; n1 += PPN) {
    for (let n2 = 0; n2 < n1; n2 += PPN) {
      const xd = N[n1]-N[n2], yd = N[n1+1]-N[n2+1];
      const d2 = xd*xd + yd*yd;
      if (d2 > 0) {
        const f = (c * N[n1+6] * N[n2+6]) / d2;
        N[n1+2] += xd*f; N[n1+3] += yd*f;
        N[n2+2] -= xd*f; N[n2+3] -= yd*f;
      }
    }
  }
  const g = options.gravity / options.scalingRatio;
  if (options.strongGravityMode) {
    for (let n = 0; n < order; n += PPN) {
      const f = c * N[n+6] * g;
      N[n+2] -= N[n]*f; N[n+3] -= N[n+1]*f;
    }
  }
  for (let e = 0; e < size; e += 3) {
    const n1=E[e], n2=E[e+1], w=E[e+2];
    const xd=N[n1]-N[n2], yd=N[n1+1]-N[n2+1], f=-w;
    N[n1+2]+=xd*f; N[n1+3]+=yd*f; N[n2+2]-=xd*f; N[n2+3]-=yd*f;
  }
  for (let n = 0; n < order; n += PPN) {
    if (N[n+9]!==1) {
      const sw = N[n+6]*Math.sqrt((N[n+4]-N[n+2])**2+(N[n+5]-N[n+3])**2);
      const tr = Math.sqrt((N[n+4]+N[n+2])**2+(N[n+5]+N[n+3])**2)/2;
      const sp = (N[n+7]*Math.log(1+tr))/(1+Math.sqrt(sw));
      N[n+7] = Math.min(1, Math.sqrt((sp*(N[n+2]**2+N[n+3]**2))/(1+Math.sqrt(sw))));
      N[n] += N[n+2]*(sp/options.slowDown);
      N[n+1] += N[n+3]*(sp/options.slowDown);
    }
  }
}

function pearsonDists(a: Float32Array, b: Float32Array, n: number): number {
  const da: number[] = [], db: number[] = [];
  // Sample pairs for speed
  const step = Math.max(1, Math.floor(n / 30));
  for (let i = 0; i < n; i += step) {
    for (let j = i + step; j < n; j += step) {
      const ax=a[i*PPN]-a[j*PPN], ay=a[i*PPN+1]-a[j*PPN+1];
      const bx=b[i*PPN]-b[j*PPN], by=b[i*PPN+1]-b[j*PPN+1];
      da.push(Math.sqrt(ax*ax+ay*ay));
      db.push(Math.sqrt(bx*bx+by*by));
    }
  }
  let sa=0,sb=0,sab=0,sa2=0,sb2=0;
  for (let i=0;i<da.length;i++){
    sa+=da[i];sb+=db[i];sab+=da[i]*db[i];sa2+=da[i]*da[i];sb2+=db[i]*db[i];
  }
  const num=da.length*sab-sa*sb;
  const den=Math.sqrt((da.length*sa2-sa*sa)*(da.length*sb2-sb*sb));
  return den===0?1:num/den;
}

const N = 30;
const nodes: NodeInput[] = Array.from({length:N},(_,i)=>({
  x: Math.cos(2*Math.PI*i/N)*500+(Math.random()-0.5)*100,
  y: Math.sin(2*Math.PI*i/N)*500+(Math.random()-0.5)*100,
  size: 5,
}));
const edges: EdgeInput[] = [];
for (let i=0;i<N;i++){
  edges.push({source:i,target:(i+1)%N,weight:1});
  if(i+3<N) edges.push({source:i,target:i+3,weight:0.5});
}

const mG = buildMatrices(nodes, edges);
const mB = { nodes: new Float32Array(mG.nodes), edges: new Float32Array(mG.edges) };
const settings: FA3Settings = {
  ...DEFAULT_SETTINGS, scalingRatio:10, gravity:0.05,
  strongGravityMode:true, slowDown:1+Math.log(N),
};

console.log("iter\tcorrelation\tdelta");
let prevCorr = 1.0;
for (let iter = 0; iter < 200; iter++) {
  iterate(settings, mG.nodes, mG.edges, iter);
  bruteForceIterate(settings, mB.nodes, mB.edges);
  if (iter % 10 === 9) {
    const corr = pearsonDists(mG.nodes, mB.nodes, N);
    const delta = corr - prevCorr;
    console.log(`${iter+1}\t${corr.toFixed(6)}\t${delta.toFixed(6)}`);
    prevCorr = corr;
  }
}
