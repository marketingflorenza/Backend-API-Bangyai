export default async function handler(req, res) {
  // --- CORS Headers: อนุญาตให้เว็บอื่น (เช่น Dashboard ของคุณ) เรียกใช้ API นี้ได้ ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ตอบกลับทันทีสำหรับ OPTIONS request (จำเป็นสำหรับ CORS)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // --- ดึงค่า Environment Variables ที่ตั้งค่าไว้บน Vercel ---
    const accessToken = process.env.FB_ACCESS_TOKEN;
    const adAccountId = process.env.AD_ACCOUNT_ID;

    // ตรวจสอบว่ามี Token และ ID ครบถ้วน
    if (!accessToken || !adAccountId) {
      return res.status(500).json({ success: false, error: 'Missing environment variables' });
    }

    // --- รับค่าวันที่จาก Dashboard ---
    const { since, until } = req.query;
    
    // --- ฟังก์ชันช่วยเหลือ (Helpers) ---
    const convertDateFormat = (dateStr) => {
      if (!dateStr) return null;
      const parts = dateStr.split('-');
      return `${parts[2]}-${parts[1]}-${parts[0]}`; // แปลง DD-MM-YYYY เป็น YYYY-MM-DD
    };
    const getUTCDateString = (date) => date.toISOString().split('T')[0];
    const getPurchases = (actions) => {
        if (!actions) return 0;
        const purchaseAction = actions.find(a => a.action_type === 'omni_purchase' || a.action_type === 'purchase');
        return purchaseAction ? parseInt(purchaseAction.value) : 0;
    };
    const getMessagingConversations = (actions) => {
        if (!actions) return 0;
        const messageAction = actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d');
        return messageAction ? parseInt(messageAction.value) : 0;
    };

    // --- ตั้งค่าช่วงวันที่ ---
    const today = new Date();
    // Facebook API นับย้อนหลัง 29 วันจะได้ข้อมูล 30 วัน (รวมวันนี้)
    const thirtyDaysAgo = new Date(new Date().setDate(today.getDate() - 29));
    const dateStart = since ? convertDateFormat(since) : getUTCDateString(thirtyDaysAgo);
    const dateStop = until ? convertDateFormat(until) : getUTCDateString(today);
    
    // เข้ารหัส time_range สำหรับใส่ใน URL
    const timeRange = encodeURIComponent(JSON.stringify({ since: dateStart, until: dateStop }));
    const insightFields = 'spend,impressions,clicks,ctr,cpc,cpm,actions';

    // --- 1. ดึงข้อมูลสรุปยอดรวม (Totals) ของทั้ง Ad Account ---
    // เรียก API แค่ครั้งเดียวเพื่อเอายอดรวมทั้งหมด
    const totalInsightsUrl = `https://graph.facebook.com/v19.0/${adAccountId}/insights?access_token=${accessToken}&fields=${insightFields}&time_range=${timeRange}&level=account`;
    const totalInsightsResponse = await fetch(totalInsightsUrl);
    const totalInsightsData = await totalInsightsResponse.json();
    const totals = totalInsightsData.data?.[0] || {};
    
    // --- 2. ดึงข้อมูลรายวันสำหรับกราฟ (Daily Chart Data) ---
    // เรียก API แค่ครั้งเดียวเพื่อเอายอดใช้จ่ายรายวัน
    const dailyInsightsUrl = `https://graph.facebook.com/v19.0/${adAccountId}/insights?access_token=${accessToken}&fields=spend&time_range=${timeRange}&level=account&time_increment=1`;
    const dailyInsightsResponse = await fetch(dailyInsightsUrl);
    const dailyInsightsData = await dailyInsightsResponse.json();
    const dailySpend = (dailyInsightsData.data || []).map(d => ({ date: d.date_start, spend: parseFloat(d.spend || 0) }));

    // --- 3. ดึงข้อมูลแคมเปญและโฆษณาทั้งหมด (Campaign & Ad Details) ---
    const campaignsResponse = await fetch(`https://graph.facebook.com/v19.0/${adAccountId}/campaigns?access_token=${accessToken}&fields=id,name,status&limit=100`);
    const campaignsData = await campaignsResponse.json();
    const campaigns = campaignsData.data || [];

    // ใช้ Promise.all เพื่อดึงข้อมูลของทุกแคมเปญพร้อมๆ กัน
    const campaignsWithDetails = await Promise.all(
      campaigns.map(async (campaign) => {
        // ✅ เทคนิคสำคัญ: ดึงข้อมูล Ads และ Insights ของ Ads ทั้งหมดในแคมเปญนี้ในการเรียก API ครั้งเดียว
        const adsUrl = `https://graph.facebook.com/v19.0/${campaign.id}/ads?access_token=${accessToken}&fields=name,adcreatives{thumbnail_url},insights.time_range(${timeRange}){${insightFields}}&limit=50`;
        const adsDataResponse = await fetch(adsUrl);
        const adsData = await adsDataResponse.json();
        
        const adsWithDetails = (adsData.data || []).map(ad => {
          const insight = ad.insights?.data?.[0];
          return {
            id: ad.id,
            name: ad.name,
            thumbnail_url: ad.adcreatives?.data[0]?.thumbnail_url || 'https://placehold.co/120x120/0d0c1d/a0a0b0?text=No+Image',
            insights: {
              spend: parseFloat(insight?.spend || 0),
              impressions: parseInt(insight?.impressions || 0),
              cpm: parseFloat(insight?.cpm || 0),
              purchases: getPurchases(insight?.actions),
              messaging_conversations: getMessagingConversations(insight?.actions),
            }
          };
        });

        // ✅ Lนำข้อมูลจาก Ads มาคำนวณเป็นยอดรวมของ Campaign เพื่อความแม่นยำ
        const campaignInsights = adsWithDetails.reduce((acc, ad) => {
            acc.spend += ad.insights.spend;
            acc.impressions += ad.insights.impressions;
            acc.purchases += ad.insights.purchases;
            acc.messaging_conversations += ad.insights.messaging_conversations;
            return acc;
        }, { spend: 0, impressions: 0, purchases: 0, messaging_conversations: 0 });

        // คำนวณ CPM ของ Campaign ใหม่อีกครั้ง
        campaignInsights.cpm = campaignInsights.impressions > 0 ? (campaignInsights.spend / campaignInsights.impressions) * 1000 : 0;

        return { ...campaign, insights: campaignInsights, ads: adsWithDetails };
      })
    );

    // --- ส่งข้อมูลทั้งหมดกลับไปให้ Dashboard ---
    res.status(200).json({
      success: true,
      totals: {
        spend: parseFloat(totals.spend || 0),
        impressions: parseInt(totals.impressions || 0),
        clicks: parseInt(totals.clicks || 0),
        purchases: getPurchases(totals.actions),
        messaging_conversations: getMessagingConversations(totals.actions),
        ctr: parseFloat(totals.ctr || 0),
        cpc: parseFloat(totals.cpc || 0),
        cpm: parseFloat(totals.cpm || 0),
      },
      data: { 
        campaigns: campaignsWithDetails,
        dailySpend: dailySpend
      }
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}
