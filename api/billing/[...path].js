// One shared Express function keeps billing/raw webhook behavior identical locally.
module.exports=require('../../server');
module.exports.config={api:{bodyParser:false}};
