// api/webhook.js - Simple version for testing

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WEBHOOK_VERIFIED');
        res.status(200).send(challenge);
      } else {
        res.status(403).send('Forbidden');
      }
    } else {
      res.status(400).send('Bad Request');
    }
  }
  else if (req.method === 'POST') {
    const body = req.body;
    
    console.log('=== WEBHOOK RECEIVED ===');
    console.log('Body:', JSON.stringify(body, null, 2));
    
    if (body.object === 'page') {
      for (const entry of body.entry) {
        if (entry.messaging) {
          for (const webhook_event of entry.messaging) {
            const sender_psid = webhook_event.sender.id;
            console.log('Message from PSID:', sender_psid);
            
            if (webhook_event.message) {
              console.log('Message text:', webhook_event.message.text);
            }
          }
        }
      }
    }
    
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
};
