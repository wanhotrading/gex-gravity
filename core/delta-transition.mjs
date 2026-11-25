import {greeks,normalCdf} from './engine.mjs';

// Individual-option delta crossings. Fixed IV/time, actual signed model delta;
// no position size, dealer ownership or execution assumptions enter this range.
export function deltaTransitionRange(input,{tail=.05}={}) {
  if(![.05,.01].includes(tail))throw new RangeError('Use a 0.05 or 0.01 delta tail.');
  const current=greeks(input);
  if(current.status!=='active')return {status:'expired',model:current.model,currentDelta:null,lower:null,upper:null,tail};
  const numerical=current.model.model==='American futures CRR'&&(input.rate??0)>0;
  const targets=input.optionType==='call'?[tail,1-tail]:[-(1-tail),-tail];
  const crossing=(targetDelta,index)=>{
    let price;
    if(!numerical){
      const discount=Math.exp(-(input.rate??0)*input.timeYears);
      const probability=input.optionType==='call'?targetDelta/discount:1+targetDelta/discount;
      if(!(probability>0&&probability<1))return {targetDelta,price:null,reason:'Target outside discounted delta range'};
      let lo=-12,hi=12;
      for(let i=0;i<64;i++){const mid=(lo+hi)/2;if(normalCdf(mid)<probability)lo=mid;else hi=mid;}
      const a=input.iv*Math.sqrt(input.timeYears);
      price=input.strike*Math.exp(a*(lo+hi)/2-.5*a*a);
    }else{
      let width=Math.min(40,Math.max(.05,8*input.iv*Math.sqrt(input.timeYears))),lo,hi,low,high;
      const at=logPrice=>greeks({...input,futuresPrice:input.strike*Math.exp(logPrice)}).delta;
      for(let i=0;i<8;i++){
        lo=-width;hi=width;low=at(lo);high=at(hi);
        if(low<=targetDelta&&high>=targetDelta)break;
        width=Math.min(40,width*2);
      }
      if(!(low<=targetDelta&&high>=targetDelta))return {targetDelta,price:null,reason:'Numerical delta crossing unavailable'};
      for(let i=0;i<42;i++){const mid=(lo+hi)/2;if(at(mid)<targetDelta)lo=mid;else hi=mid;}
      price=input.strike*Math.exp((lo+hi)/2);
    }
    if(!(Number.isFinite(price)&&price>0))return {targetDelta,price:null,reason:'Delta crossing exceeds supported price range'};
    const delta=greeks({...input,futuresPrice:price}).delta;
    if(Math.abs(delta-targetDelta)>.001)return {targetDelta,price:null,reason:'Numerical delta crossing could not be resolved'};
    return {targetDelta,price,delta,deltaChange:targetDelta-current.delta,distance:price-input.futuresPrice,
      percent:(price/input.futuresPrice-1)*100,
      alreadyBeyond:index===0?current.delta<=targetDelta:current.delta>=targetDelta};
  };
  return {status:'active',model:current.model,currentDelta:current.delta,tail,numerical,
    lower:crossing(targets[0],0),upper:crossing(targets[1],1)};
}
