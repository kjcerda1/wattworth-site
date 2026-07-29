const REQUIRED=['firstName','lastName','email','phone','zip','billRange','ownership','roofType','roofAge','consent'];
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function clean(value,max=250){return String(value??'').trim().slice(0,max)}
module.exports=async function handler(req,res){
  res.setHeader('Content-Type','application/json');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'Method not allowed.'})}
  const body=req.body&&typeof req.body==='object'?req.body:{};
  if(clean(body.company))return res.status(200).json({ok:true});
  for(const field of REQUIRED){if(!clean(body[field]))return res.status(400).json({error:`Missing required field: ${field}.`})}
  if(!EMAIL.test(clean(body.email)))return res.status(400).json({error:'Please enter a valid email address.'});
  if(!/^\d{5}$/.test(clean(body.zip)))return res.status(400).json({error:'Please enter a valid 5-digit ZIP code.'});
  const lead={leadId:`WW-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`,submittedAt:new Date().toISOString(),firstName:clean(body.firstName,80),lastName:clean(body.lastName,80),email:clean(body.email,160),phone:clean(body.phone,40),zip:clean(body.zip,5),utility:clean(body.utility,120),billRange:clean(body.billRange,40),ownership:clean(body.ownership,20),roofType:clean(body.roofType,60),roofAge:clean(body.roofAge,40),consent:true,estimate:body.estimate||{},source:clean(body.source,500)};
  const webhook=process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const secret=process.env.WATTWORTH_WEBHOOK_SECRET;
  if(!webhook||!secret)return res.status(503).json({error:'Lead storage is not configured yet.'});
  try{const target=new URL(webhook);target.searchParams.set('secret',secret);const response=await fetch(target,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(lead)});if(!response.ok)throw new Error(`Storage returned ${response.status}`);const stored=await response.json().catch(()=>({ok:false}));if(!stored.ok)throw new Error(stored.error||'Storage rejected lead');return res.status(201).json({ok:true,leadId:lead.leadId})}catch(error){console.error('lead_storage_failed',{message:error.message,leadId:lead.leadId});return res.status(502).json({error:'We could not securely save your request. Please try again.'})}
}
