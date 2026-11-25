/** Parse provider-exported text as data. This module never evaluates input or
 * assigns a GEX magnitude to a ranked provider level.
 */
const months='FGHJKMNQUVXZ';
const realDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
function fail(message){throw Error(message);}
export function menthorqInstrument(market,underlyingCode){
  if(!['NQ','ES','CL'].includes(market)||!new RegExp(`^US\\.${market}[0-9]{4}$`).test(underlyingCode??''))fail('Select an exact dated NQ, ES or CL futures month before importing.');
  const month=Number(underlyingCode.slice(-2));
  if(month<1||month>12)fail('The selected futures month is invalid.');
  return market+months[month-1]+'20'+underlyingCode.slice(-4,-2);
}
const referenceLabel=label=>/^1D\s*(?:Min|Max)$/i.test(label.trim());

export function parseMenthorqExport({market,underlyingCode,exportText,sourceDate,sourceLocalTime='',mode}={},now=Date.now()){
  const instrument=menthorqInstrument(market,underlyingCode);
  if(typeof exportText!=='string'||!exportText.trim()||exportText.length>20000)fail('Paste a MenthorQ export containing up to 20,000 characters.');
  if(!realDate(sourceDate))fail('Enter the actual provider date as YYYY-MM-DD.');
  if(!['Intraday','EOD'].includes(mode))fail('Choose Intraday or EOD to match the provider export.');
  if(typeof sourceLocalTime!=='string')fail('Use the displayed provider time as HH:mm, or leave it blank.');
  sourceLocalTime=sourceLocalTime.trim();
  if(sourceLocalTime&&!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(sourceLocalTime))fail('Use the displayed provider time as HH:mm, or leave it blank.');
  if(!Number.isFinite(now))fail('The import capture time is unavailable.');

  const headers=[...exportText.matchAll(/\$([A-Za-z0-9_.!-]+)\s*:/g)];
  const selected=headers.map((header,index)=>({instrument:header[1],text:exportText.slice(header.index+header[0].length,headers[index+1]?.index??exportText.length)})).filter(section=>section.instrument===instrument);
  if(!selected.length)fail(`This export must contain $${instrument}: for the selected futures month. Continuous, cash or other-month levels cannot be substituted.`);
  const levels=new Map();
  for(const section of selected){
    const tokens=section.text.split(/[,\r\n]+/).map(value=>value.trim()).filter(Boolean);
    if(!tokens.length||tokens.length%2!==0)fail(`The $${instrument} section needs complete label, strike pairs. Paste the provider export without editing its separators.`);
    for(let index=0;index<tokens.length;index+=2){
      const label=tokens[index],raw=tokens[index+1];
      if(label.length>100||!/[A-Za-z]/.test(label)||/[\u0000-\u001f]/.test(label)||!/^\d+(?:\.\d+)?$/.test(raw))fail(`A label or strike in $${instrument} is invalid. Paste the original provider export.`);
      const strike=Number(raw);if(!positive(strike))fail('Every exported level must have a positive numeric strike.');
      const kind=referenceLabel(label)?'reference':'option-strike';
      if(levels.has(strike)){
        const previous=levels.get(strike);
        if(!previous.labels.includes(label))previous.labels.push(label);
        if(kind==='option-strike')previous.kind='option-strike';
      }else levels.set(strike,{strike,labels:[label],kind,gex:null,deltaExposure:null,openInterest:null,iv:null,sourceAsOf:null,scope:'Provider label scope; aggregate and 0DTE levels may coexist.'});
      if(levels.size>80)fail('This export contains more than 80 selected levels. Import a smaller provider selection.');
      if(levels.get(strike).labels.length>12)fail('One strike has more than 12 provider labels. Import a smaller provider selection.');
    }
  }
  const notes=[
    `Imported from the MenthorQ ${mode} text export for provider date ${sourceDate}.`,
    sourceLocalTime?`Provider displayed ${sourceDate} ${sourceLocalTime} without a timezone. Exact source timestamp remains unknown.`:'No exact provider timestamp and timezone were supplied. Source date is not an exact source time.',
    'GEX 1, GEX 2 and similar labels identify provider-selected levels or ranks, not GEX magnitudes. Exposure values remain unavailable.',
    '1D Min and 1D Max are forecast/reference levels; those labels alone do not identify listed option strikes.',
  ];
  return {schemaVersion:1,source:'MenthorQ',underlyingCode,sourceInstrument:instrument,sourceDate,sourceLocalTime,mode,asOf:null,
    capturedAt:new Date(now).toISOString(),expiryScope:`MenthorQ ${mode} export; aggregate and 0DTE labels retain their provider scope.`,
    sourceUrl:null,gexUnit:null,deltaExposureUnit:null,levels:[...levels.values()].sort((a,b)=>a.strike-b.strike),notes};
}
