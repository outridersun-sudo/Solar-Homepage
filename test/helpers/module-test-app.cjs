'use strict';
const crypto=require('node:crypto');
const path=require('node:path');
function testApp() {
  process.env.ADMIN_USERNAME='module-test-admin';
  const password=crypto.randomBytes(24).toString('hex'),salt=crypto.randomBytes(16).toString('hex');
  process.env.ADMIN_PASSWORD_HASH=salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
  const express=require('express'),app=express();
  app.use(express.json());
  // Only the DB-backed login rate limiter is replaced. Session, password,
  // authorization, Origin and CSRF code are the production implementation.
  app.locals.security={loginLimit:(req,res,next)=>next()};
  require('../../server/admin')(app,{query:()=>{throw Error('Unexpected database access');}});
  require('../../server/calculator')(app);
  app.use(express.static(path.join(__dirname,'../../public')));
  app.use((error,req,res,next)=>res.status(error.status||500).json({message:error.message}));
  return {app,password};
}
module.exports={testApp};
