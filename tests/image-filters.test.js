import test from 'node:test';
import assert from 'node:assert/strict';
import { compileQuery, validRule, normalizeQuery, queryKey, normalizeViews, viewNameError } from '../extension/image-filters.js';
import { visibleImages } from '../extension/core.js';

const image = { id:'a', createdAt:0, width:900, height:1600, conversationId:'chat' };
const matches = (rule, changes = {}, options) => compileQuery({ mode:'all', rules:[rule] },options)({ ...image,...changes });
const date = (op,value,end) => ({ field:'date',op,value,end });
const timestamp = value => new Date(value).getTime();
test('calendar date boundaries include entire days and distinguish strict operators', () => {
  const previous = process.env.TZ; process.env.TZ = 'Asia/Shanghai';
  try {
    const times = ['2026-10-08T23:59:59.999+08:00','2026-10-09T00:00:00+08:00','2026-10-09T23:59:59.999+08:00','2026-10-10T00:00:00+08:00'].map(timestamp);
    for (const [op,expected] of [['day',[false,true,true,false]],['before',[true,false,false,false]],['after',[false,false,false,true]],['gte',[false,true,true,true]],['lte',[true,true,true,false]]])
      assert.deepEqual(times.map(createdAt => matches(date(op,'2026-10-09'),{createdAt})), expected,op);
    assert.equal(matches(date('range','2026-10-08','2026-10-09'),{createdAt:times[2]}),true);
    assert.equal(matches(date('range','2026-10-08','2026-10-09'),{createdAt:times[3]}),false);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('date validation rejects partial values, impossible dates and reversed intervals', () => {
  for (const value of ['2026-02-29','2026-04-31','2026-10-','2026-00-12','0000-01-01']) assert.equal(validRule(date('day',value)),false,value);
  assert.equal(validRule(date('day','2024-02-29')),true);
  assert.equal(validRule(date('range','2026-10-10','2026-10-09')),false);
  assert.equal(validRule(date('month','2026-13')),false);
  assert.equal(validRule(date('year','26')),false);
});
test('month and year filters include leap days and exclude the next calendar period', () => {
  assert.equal(matches(date('month','2024-02'),{createdAt:new Date(2024,1,29,23,59).getTime()}),true);
  assert.equal(matches(date('month','2024-02'),{createdAt:new Date(2024,2,1).getTime()}),false);
  assert.equal(matches(date('year','2024'),{createdAt:new Date(2024,11,31,23,59).getTime()}),true);
  assert.equal(matches(date('year','2024'),{createdAt:new Date(2025,0,1).getTime()}),false);
});
test('relative views advance with the calendar and handle end-of-month rollover', () => {
  const options = { now:new Date(2026,9,31,12).getTime() };
  assert.equal(matches(date('relative','month'),{createdAt:new Date(2026,10,1).getTime()},options),false);
  assert.equal(matches(date('relative','month'),{createdAt:new Date(2026,9,1).getTime()},options),true);
  assert.equal(matches(date('relative','week'),{createdAt:new Date(2026,9,25).getTime()},options),true);
  assert.equal(matches(date('relative','week'),{createdAt:new Date(2026,9,24,23,59).getTime()},options),false);
  assert.equal(matches(date('relative','year'),{createdAt:new Date(2027,0,1).getTime()},options),false);
  const rule = date('relative','today'), createdAt = new Date(2026,9,31,12).getTime();
  assert.equal(matches(rule,{createdAt},options),true);
  assert.equal(matches(rule,{createdAt},{now:new Date(2026,10,1,12).getTime()}),false);
});
test('local days remain correct across DST rather than assuming 24 hours', () => {
  const previous = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    assert.equal(matches(date('day','2026-03-08'),{createdAt:timestamp('2026-03-08T23:59:59-04:00')}),true);
    assert.equal(matches(date('day','2026-03-08'),{createdAt:timestamp('2026-03-09T00:00:00-04:00')}),false);
    assert.equal(matches(date('day','2026-11-01'),{createdAt:timestamp('2026-11-01T23:59:59-05:00')}),true);
    assert.equal(matches(date('relative','week'),{createdAt:timestamp('2026-03-02T00:00:00-05:00')},{now:timestamp('2026-03-08T12:00:00-04:00')}),true);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('ratio presets separate exact and near matches and enforce tolerance boundaries', () => {
  const exact = { field:'ratio',op:'exact',width:9,height:16 }, near = { ...exact,op:'near' };
  assert.equal(matches(exact),true);
  assert.equal(matches(exact,{width:1024,height:1792}),false);
  assert.equal(matches(near,{width:1024,height:1792}),true);
  assert.equal(matches(near,{width:918,height:1600}),true);
  assert.equal(matches(near,{width:919,height:1600}),false);
  assert.equal(matches({field:'ratio',op:'exact',width:1.85,height:1},{width:1850,height:1000}),true);
  assert.equal(validRule({...exact,height:0}),false);
  assert.equal(validRule({...exact,width:Infinity}),false);
});
test('unknown geometry and dates do not impersonate concrete values', () => {
  const unknown = {width:0,height:1600};
  assert.equal(matches({field:'direction',value:'portrait'},unknown),false);
  assert.equal(matches({field:'direction',value:'unknown'},unknown),true);
  assert.equal(matches({field:'ratio',op:'near',width:9,height:16},unknown),false);
  assert.equal(matches(date('before','2026-10-09')),false);
  assert.equal(matches(date('unknown')),true);
  assert.equal(matches({field:'direction',value:'landscape'},{width:2000,height:1000}),true);
  assert.equal(matches({field:'direction',value:'square'},{width:1000,height:1000}),true);
});
test('flat all/any composition includes chat status and does not bypass outer hidden scope', () => {
  const rules = [{field:'direction',value:'portrait'},{field:'archive',value:'archived'}];
  const state = () => ({archived:false,checkedAt:Date.now()});
  assert.equal(compileQuery({mode:'all',rules},{state})(image),false);
  assert.equal(compileQuery({mode:'any',rules},{state})(image),true);
  assert.equal(compileQuery({mode:'all',rules:[]})(image),true);
  assert.equal(compileQuery({mode:'any',rules:[]})(image),true);
  assert.equal(matches({field:'archive',value:'unarchived'},{},{state:() => undefined}),false);
  assert.equal(matches({field:'archive',value:'unknown'}),true);
  const hidden = new Set(['a']);
  assert.deepEqual(visibleImages([image],'all',hidden).filter(compileQuery({mode:'any',rules},{state})),[]);
  assert.equal(visibleImages([image],'hidden',hidden).filter(compileQuery({mode:'any',rules},{state})).length,1);
});
test('saved view definitions validate names, scopes and rules without storing image IDs', () => {
  const query = { mode:'any',rules:[{id:'r',field:'direction',value:'portrait'}] };
  const views = normalizeViews([{id:'v',name:'  竖图  ',scope:'favorites',query},{id:'v',name:'重复 ID',scope:'all',query},{id:'other',name:'竖图',scope:'all',query},{id:'bad',name:'',scope:'all',query}]);
  assert.equal(views.length,1); assert.equal(views[0].name,'竖图');
  assert.equal(viewNameError('竖图',views),'已有同名 View，请修改名称');
  assert.equal(viewNameError('竖图',views,'v'),'');
  assert.equal(queryKey(query),queryKey({...query,rules:[{...query.rules[0],id:'another'}]}));
  assert.deepEqual(normalizeQuery({mode:'bad',rules:[{field:'date',op:'day',value:'partial'}]}),{mode:'all',rules:[]});
});
