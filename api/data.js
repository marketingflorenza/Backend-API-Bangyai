export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN;
    let adAccountId = process.env.AD_ACCOUNT_ID;

    if (!accessToken || !adAccountId) {
      return res.status(500).json({ error: 'Missing environment variables', success: false });
    }

    if (!adAccountId.startsWith('act_')) adAccountId = `act_${adAccountId}`;

    // Helper Functions
    const convertDateFormat = (dateStr) => {
      if (!dateStr) return null;
      const parts = dateStr.split('-');
      return parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : null;
    };

    const formatDateForResponse = (dateStr) => {
      if (!dateStr) return null;
      const parts = dateStr.split('-');
      return parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : dateStr;
    };

    const getUTCDateString = (date) => {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // 1. Timezone & Date Logic
    let timezoneOffset = 0;
    try {
      const accountResponse = await fetch(
        `https://graph.facebook.com/v19.0/${adAccountId}?access_token=${accessToken}&fields=timezone_offset_hours_utc`
      );
      if (accountResponse.ok) {
        const data = await accountResponse.json();
        timezoneOffset = parseFloat(data.timezone_offset_hours_utc || 0);
      }
    } catch (e) { console.error(e); }

    const { since, until } = req.query;
    const now = new Date();
    const accountNow = new Date(now.getTime() + (timezoneOffset * 60 * 60 * 1000));
    
    // [แก้ไข] ขยาย Default Range เป็น 90 วัน เพื่อให้เห็นข้อมูลเก่า
    const today = new Date(accountNow.getUTCFullYear(), accountNow.getUTCMonth(), accountNow.getUTCDate());
    const ninetyDaysAgo = new Date(today.getTime() - (90 * 24 * 60 * 60 * 1000)); 

    let dateStart, dateStop;

    if (since) {
      dateStart = convertDateFormat(since);
    } else {
      dateStart = getUTCDateString(ninetyDaysAgo); // ใช้ 90 วัน
    }

    if (until) {
      dateStop = convertDateFormat(until);
    } else {
      dateStop = getUTCDateString(today);
    }

    // 2. Fetch Campaigns (ดึงหมด ไม่สน Status)
    const campaignsUrl = `https://graph.facebook.com/v19.0/${adAccountId}/campaigns?access_token=${accessToken}&fields=id,name,status,objective,created_time,updated_time,effective_status&limit=200`;
    
    const campaignsRes = await fetch(campaignsUrl);
    if (!campaignsRes.ok) throw new Error('Failed to fetch campaigns');
    
    const campaignsData = await campaignsRes.json();
    const campaigns = campaignsData.data || [];

    // 3. Fetch Insights & Ads
    const campaignsWithDetails = await Promise.all(
      campaigns.map(async (campaign, index) => {
        try {
          if (index > 0) await new Promise(r => setTimeout(r, 20));

          // ใช้ time_range เสมอเพื่อความแม่นยำตามช่วงวันที่กำหนด
          const timeRange = encodeURIComponent(JSON.stringify({ since: dateStart, until: dateStop }));
          const insightsUrl = `https://graph.facebook.com/v19.0/${campaign.id}/insights?access_token=${accessToken}&fields=spend,impressions,clicks,reach,ctr,cpc,cpm&time_range=${timeRange}&level=campaign`;

          const insightsRes = await fetch(insightsUrl);
          let insights = {}; // ใช้ Object ว่างแทน null เพื่อกัน Error
          
          if (insightsRes.ok) {
            const data = await insightsRes.json();
            insights = data.data?.[0] || {};
          }

          // Fetch Ads (Limit 3)
          const adsRes = await fetch(`https://graph.facebook.com/v19.0/${campaign.id}/ads?access_token=${accessToken}&fields=id,name,status&limit=3`);
          let ads = [];
          if (adsRes.ok) {
            const adsData = await adsRes.json();
            ads = adsData.data || [];
          }

          // Fetch Images (Limit 1)
          const adsWithImages = await Promise.all(
            ads.slice(0, 1).map(async (ad) => {
              try {
                const creativeRes = await fetch(`https://graph.facebook.com/v19.0/${ad.id}/adcreatives?access_token=${accessToken}&fields=image_url,thumbnail_url,object_story_spec`);
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

          // [แก้ไขสำคัญ] Flatten Data: ดึงค่าออกมาไว้นอกสุด
          return {
            ...campaign,
            // แปลงค่าเงินให้เป็น Number ทันที และวางไว้ชั้นนอก
            spend: parseFloat(insights.spend || 0),
            impressions: parseInt(insights.impressions || 0),
            clicks: parseInt(insights.clicks || 0),
            reach: parseInt(insights.reach || 0),
            ctr: parseFloat(insights.ctr || 0),
            cpc: parseFloat(insights.cpc || 0),
            cpm: parseFloat(insights.cpm || 0),
            // เก็บตัวเดิมไว้เผื่อ Frontend ใช้
            insights: {
              ...insights,
              spend: parseFloat(insights.spend || 0)
            },
            ads: adsWithImages
          };

        } catch (e) {
          console.error(e);
          return { ...campaign, error: e.message, spend: 0, ads: [] };
        }
      })
    );

    // 4. Calculate Totals
    const totals = campaignsWithDetails.reduce((acc, c) => {
      acc.spend += c.spend;
      acc.impressions += c.impressions;
      acc.clicks += c.clicks;
      acc.reach += c.reach;
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
        // ส่ง List ที่ Flatten แล้วออกไป
        campaigns: campaignsWithDetails
      }
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}
