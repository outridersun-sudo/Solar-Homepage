'use strict';
const catalog=require('./module-catalog');

module.exports=function registerModules(app){
  app.get('/api/admin/modules',(req,res,next)=>{
    try{res.json({rows:catalog.list()});}catch(error){next(error);}
  });
  require('./module-text-import')(app);
};
