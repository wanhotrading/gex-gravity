import test from 'node:test';
import assert from 'node:assert/strict';
import {panPriceWindow,zoomPriceWindow} from './chart-navigation.mjs';

test('drag shifts the whole price window and respects the positive model floor',()=>{
  const view={lo:80,hi:100};
  assert.deepEqual(panPriceWindow(view,10,1),{lo:90,hi:110});
  assert.deepEqual(panPriceWindow(view,-90,1),{lo:1,hi:21});
});

test('wheel zoom keeps the cursor price fixed and leaves at least two ticks visible',()=>{
  const view={lo:80,hi:100},fraction=.25;
  const zoomed=zoomPriceWindow(view,.5,fraction,1,.25);
  assert.deepEqual(zoomed,{lo:82.5,hi:92.5});
  assert.equal(zoomed.lo+(zoomed.hi-zoomed.lo)*fraction,85);
  assert.deepEqual(zoomPriceWindow(zoomed,2,fraction,1,.25),view);
  const tight=zoomPriceWindow(view,.0001,.5,1,.25);
  assert.equal(tight.hi-tight.lo,.5);
});
