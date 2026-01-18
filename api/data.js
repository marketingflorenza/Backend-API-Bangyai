export default async function handler(req, res) {
  // 1. ตั้งค่า CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // 2. ดึงค่า Environment Variables
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN;
    let adAccountId = process.env.AD_ACCOUNT_ID;

    if (!accessToken || !adAccountId) {
      return res.status(500).json({ 
        error: 'Missing environment variables',
        success: false
      });
    }

    if (!adAccountId.startsWith('act_')) {
      adAccountId = `act_${adAccountId}`;
    }

    // Helper Functions
    function convertDateFormat(dateStr) {
      if (!dateStr) return null;
      const parts = dateStr.split('-');
      if (parts.length !== 3) return null;
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }

    function formatDateForResponse(dateStr) {
      if (!dateStr) return null;
      const parts = dateStr.split('-');
      if (parts.length !== 3) return dateStr;
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }

    function getUTCDateString(date) {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    // ---------------------------------------------------------
    // 3. เริ่มต้น Timezone และ Date Logic
    // ---------------------------------------------------------
    let adAccountTimezone = null;
    let timezoneOffset = 0;

    try {
      const accountResponse = await fetch(
        `https://graph.facebook.com/v19.0/${adAccountId}?access_token=${accessToken}&fields=timezone_id,timezone_name,timezone_offset_hours_utc`
      );
      if (accountResponse.ok) {
        const accountData = await accountResponse.json();
        if (!accountData.error) {
          adAccountTimezone = accountData;
          timezoneOffset = parseFloat(accountData.timezone_offset_hours_utc || 0);
        }
      }
    } catch (error) {
      console.error('Error fetching timezone:', error);
    }

    const { since, until } = req.query;
    const now = new Date();
    const accountNow = new Date(now.getTime() + (timezoneOffset * 60 * 60 * 1000));
    const today = new Date(accountNow.getUTCFullYear(), accountNow.getUTCMonth(), accountNow.getUTCDate());
    const thirtyDaysAgo = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000));

    let dateStart, dateStop;
    let originalSince = since;
    let originalUntil = until;

    if (since) {
      dateStart = convertDateFormat(since);
      if (!dateStart) return res.status(400).json({ success: false, error: 'Invalid since date' });
    } else {
      dateStart = getUTCDateString(thirtyDaysAgo);
      originalSince = formatDateForResponse(dateStart);
    }

    if (until) {
      dateStop = convertDateFormat(until);
      if (!dateStop) return res.status(400).json({ success: false, error: 'Invalid until date' });
    } else {
      dateStop = getUTCDateString(today);
      originalUntil = formatDateForResponse(dateStop);
    }

    // ---------------------------------------------------------
    // 4. ดึง Campaigns (แก้ไข: ปลดล็อก Filter ออกทั้งหมด)
    // ---------------------------------------------------------
    
    // เอา filtering ออก เพื่อให้เห็น Campaign เก่าๆ ที่จบไปแล้ว หรือ Archive ไปแล้วด้วย
    // เพิ่ม limit เป็น 200 เพื่อให้แน่ใจว่าดึงมาครบ
    const campaignsUrl = `https://graph.facebook.com/v19.0/${adAccountId}/campaigns?access_token=${accessToken}&fields=id,name,status,objective,created_time,updated_time,effective_status&limit=200`;

    const campaignsResponse = await fetch(campaignsUrl);
    if (!campaignsResponse.ok) throw new Error('Failed to fetch campaigns');
    
    const campaignsData = await campaignsResponse.json();
    if (campaignsData.error) throw new Error(campaignsData.error.message);

    const campaigns = campaignsData.data || [];
    const isLast30Days = dateStart === getUTCDateString(thirtyDaysAgo) && dateStop === getUTCDateString(today);

    // ---------------------------------------------------------
    // 5. ดึง Insights & Ads Details
    // ---------------------------------------------------------

    const campaignsWithDetails = await Promise.all(
      campaigns.map(async (campaign, index) => {
        try {
          if (index > 0) await new Promise(r => setTimeout(r, 50));

          let insightsUrl;
          const fields = 'spend,impressions,clicks,reach,ctr,cpc,cpm,frequency,actions,cost_per_action_type';
          
          if (isLast30Days) {
            insightsUrl = `https://graph.facebook.com/v19.0/${campaign.id}/insights?access_token=${accessToken}&fields=${fields}&date_preset=last_30d&level=campaign`;
          } else {
            const timeRange = encodeURIComponent(JSON.stringify({ since: dateStart, until: dateStop }));
            insightsUrl = `https://graph.facebook.com/v19.0/${campaign.id}/insights?access_token=${accessToken}&fields=${fields}&time_range=${timeRange}&level=campaign`;
          }

          const insightsResponse = await fetch(insightsUrl);
          let insights = null;
          if (insightsResponse.ok) {
            const data = await insightsResponse.json();
            insights = data.data?.[0] || null;
          }

          // ถ้าไม่มี Insights (เช่น แคมเปญสร้างไว้แต่ไม่ได้ยิงโฆษณาในช่วงเวลานี้) ให้ข้ามส่วน Ads ไปเลยเพื่อประหยัดเวลา
          // หรือถ้าต้องการแสดงชื่อแคมเปญแม้ Spend = 0 ก็ให้รันต่อ
          // ในที่นี้เลือกที่จะดึง Ads ต่อ เพื่อให้เห็นว่ามีแคมเปญอยู่จริง

          // Fetch Ads (Limit 5)
          const adsResponse = await fetch(
            `https://graph.facebook.com/v19.0/${campaign.id}/ads?access_token=${accessToken}&fields=id,name,status&limit=5`
          );
          let ads = [];
          if (adsResponse.ok) {
            const adsData = await adsResponse.json();
            ads = adsData.data || [];
          }

          // Fetch Images (Limit 2)
          const adsWithImages = await Promise.all(
             ads.slice(0, 2).map(async (ad) => {
               try {
                 const creativeRes = await fetch(
                   `https://graph.facebook.com/v19.0/${ad.id}/adcreatives?access_token=${accessToken}&fields=image_url,thumbnail_url,object_story_spec`
                 );
                 let images = [];
                 if (creativeRes.ok) {
                   const cData = await creativeRes.json();
                   (cData.data || []).forEach(c => {
                     if (c.image_url) images.push({ type: 'image', url: c.image_url });
                     else if (c.object_story_spec?.link_data?.picture) images.push({ type: 'link_image', url: c.object_story_spec.link_data.picture });
                   });
                 }
                 return { ...ad, images };
               } catch (e) { return { ...ad, images: [] }; }
             })
          );

          return { ...campaign, insights, ads: adsWithImages };
        } catch (e) {
          return { ...campaign, error: e.message, ads: [] };
        }
      })
    );

    // ---------------------------------------------------------
    // 6. กรองแคมเปญที่มีข้อมูล (Optional: ถ้าอยากแสดงเฉพาะที่มี Spend)
    // ---------------------------------------------------------
    
    // ถ้าอยากให้แสดง *ทุกแคมเปญ* (แม้ Spend = 0) ให้ใช้บรรทัดนี้:
    const finalCampaigns = campaignsWithDetails;
    
    // แต่ถ้าอยากให้แสดง *เฉพาะแคมเปญที่มี Spend ในช่วงเวลานั้น* ให้เปิดบรรทัดล่างนี้แทน:
    // const finalCampaigns = campaignsWithDetails.filter(c => c.insights && parseFloat(c.insights.spend) > 0);


    // ---------------------------------------------------------
    // 7. คำนวณ Totals และ FORMAT DATA
    // ---------------------------------------------------------

    const totals = finalCampaigns.reduce((acc, campaign) => {
      if (campaign.insights) {
        acc.spend += parseFloat(campaign.insights.spend || 0);
        acc.impressions += parseInt(campaign.insights.impressions || 0);
        acc.clicks += parseInt(campaign.insights.clicks || 0);
        acc.reach += parseInt(campaign.insights.reach || 0);
      }
      return acc;
    }, { spend: 0, impressions: 0, clicks: 0, reach: 0 });

    res.status(200).json({
      success: true,
      message: 'Data retrieved successfully',
      dateRange: {
        start: formatDateForResponse(dateStart),
        end: formatDateForResponse(dateStop)
      },
      totals: {
        spend: parseFloat(totals.spend.toFixed(2)),
        impressions: totals.impressions,
        clicks: totals.clicks,
        reach: totals.reach,
        ctr: totals.impressions ? parseFloat(((totals.clicks / totals.impressions) * 100).toFixed(2)) : 0,
        cpc: totals.clicks ? parseFloat((totals.spend / totals.clicks).toFixed(2)) : 0
      },
      data: {
        campaigns: finalCampaigns.map(campaign => ({
          ...campaign,
          insights: campaign.insights ? {
            ...campaign.insights,
            spend: parseFloat(campaign.insights.spend || 0),
            impressions: parseInt(campaign.insights.impressions || 0),
            clicks: parseInt(campaign.insights.clicks || 0),
            reach: parseInt(campaign.insights.reach || 0),
            ctr: parseFloat(campaign.insights.ctr || 0),
            cpc: parseFloat(campaign.insights.cpc || 0),
            cpm: parseFloat(campaign.insights.cpm || 0)
          } : {
            // กรณีไม่มี Insights ให้ส่งค่า 0 ไปแทน null เพื่อไม่ให้ Frontend Error
            spend: 0,
            impressions: 0,
            clicks: 0,
            reach: 0,
            ctr: 0,
            cpc: 0,
            cpm: 0
          }
        }))
      }
    });

  } catch (error) {
    console.error('API Critical Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}
