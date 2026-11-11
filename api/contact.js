const {serverDb} = require('../lib/store-access');
const {rate, clientIp} = require('../lib/request-security');

module.exports = async function contact(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({error: 'METHOD_NOT_ALLOWED'});
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message || message.length > 2000) {
        return res.status(400).json({error: 'INVALID_CONTACT'});
    }
    try {
        const db = serverDb();
        await rate(db, 'contact:' + clientIp(req), 3);
        const {error} = await db.from('cc_support_messages').insert({email, message}).abortSignal(AbortSignal.timeout(5000));
        if (error) throw error;
        return res.status(201).json({ok: true});
    } catch (error) {
        const status = error.status === 429 ? 429 : 503;
        return res.status(status).json({error: status === 429 ? 'RATE_LIMITED' : 'CONTACT_UNAVAILABLE'});
    }
};
