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
    // 2. ดึงค่า Environment Variables (รองรับทั้งชื่อเก่าและใหม่)
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN;
    let adAccountId = process.env.AD_ACCOUNT_ID;

    // ตรวจสอบว่ามีค่าหรือไม่
    if (!accessToken || !adAccountId) {
      return res.status(500).json({ 
        error: 'Missing environment variables (FACEBOOK_ACCESS_TOKEN or AD_ACCOUNT_ID)',
        success: false
      });
    }

    // แก้ไข Format ของ Ad Account ID ให้มี 'act_' นำหน้าเสมอ
    if (!adAccountId.startsWith('act_')) {
      adAccountId = `act_${adAccountId}`;
    }

    // ---------------------------------------------------------
    // ส่วน Helper Functions
    // ---------------------------------------------------------
    
    // แปลงวันที่จาก DD-MM-YYYY เป็น YYYY-MM-DD
    function convertDateFormat(dateStr) {
      if (!dateStr) return null;
      const parts = dateStr.split('-');
      if (parts.length !== 3) return null;
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2];
      if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
      return `${year}-${month}-${day}`;
    }

    // แปลงวันที่จาก YYYY-MM-DD กลับเป็น DD-MM-YYYY
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
    // 3. เริ่มต้นกระบวนการดึงข้อมูล
    // ---------------------------------------------------------

    // 3.1 ดึง Timezone ของ Ad Account
    let adAccountTimezone = null;
    let timezoneOffset = 0; // Default UTC

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
      console.error('Error fetching ad account timezone:', error);
    }

    // 3.2 คำนวณวันและเวลา (Time Range Logic)
    const { since, until } = req.query;
    const now = new Date();
    // ปรับเวลาให้ตรงกับ Ad Account Timezone
    const accountNow = new Date(now.getTime() + (timezoneOffset * 60 * 60 * 1000));
    const today = new Date(accountNow.getUTCFullYear(), accountNow.getUTCMonth(), accountNow.getUTCDate());
    const thirtyDaysAgo = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000));

    let dateStart, dateStop;
    let originalSince = since;
    let originalUntil = until;

    if (since) {
      dateStart = convertDateFormat(since);
      if (!dateStart) return res.status(400).json({ success: false, error: 'Invalid since date (DD-MM-YYYY)' });
    } else {
      dateStart = getUTCDateString(thirtyDaysAgo);
      originalSince = formatDateForResponse(dateStart);
    }

    if (until) {
      dateStop = convertDateFormat(until);
      if (!dateStop) return res.status(400).json({ success: false, error: 'Invalid until date (DD-MM-YYYY)' });
    } else {
      dateStop = getUTCDateString(today);
      originalUntil = formatDateForResponse(dateStop);
    }

    // ---------------------------------------------------------
    // 4. ดึงข้อมูล Campaigns (จุดสำคัญที่แก้ไข)
    // ---------------------------------------------------------
    
    // เพิ่ม filtering เอาเฉพาะ ACTIVE และ PAUSED เพื่อไม่ให้ติด Campaign เก่าๆ ที่ปิดไปแล้ว
    // เพิ่ม limit เป็น 100
    const campaignsUrl = `https://graph.facebook.com/v19.0/${adAccountId}/campaigns?access_token=${accessToken}&fields=id,name,status,objective,created_time,updated_time,effective_status&limit=100&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]`;

    const campaignsResponse = await fetch(campaignsUrl);

    if (!campaignsResponse.ok) {
      const errorText = await campaignsResponse.text();
      throw new Error(`Facebook API campaigns error: ${campaignsResponse.status} - ${errorText}`);
    }

    const campaignsData = await campaignsResponse.json();
    if (campaignsData.error) {
      throw new Error(`Facebook API Error: ${campaignsData.error.message}`);
    }

    const campaigns = campaignsData.data || [];
    const isLast30Days = dateStart === getUTCDateString(thirtyDaysAgo) && dateStop === getUTCDateString(today);

    // ---------------------------------------------------------
    // 5. ดึง Insights และ Ads ของแต่ละ Campaign
    // ---------------------------------------------------------

    const campaignsWithDetails = await Promise.all(
      campaigns.map(async (campaign, index) => {
        try {
          // Delay เล็กน้อยเพื่อกัน Rate Limit
          if (index > 0) await new Promise(resolve => setTimeout(resolve, 50));

          // สร้าง URL สำหรับ Insights
          let insightsUrl;
          const fields = 'spend,impressions,clicks,reach,ctr,cpc,cpm,frequency,actions,cost_per_action_type';
          
          if (isLast30Days) {
            insightsUrl = `https://graph.facebook.com/v19.0/${campaign.id}/insights?access_token=${accessToken}&fields=${fields}&date_preset=last_30d&level=campaign`;
          } else {
            const timeRange = encodeURIComponent(JSON.stringify({ since: dateStart, until: dateStop }));
            insightsUrl = `https://graph.facebook.com/v19.0/${campaign.id}/insights?access_token=${accessToken}&fields=${fields}&time_range=${timeRange}&level=campaign`;
          }

          // ดึง Insights
          const insightsResponse = await fetch(insightsUrl);
          let insights = null;
          if (insightsResponse.ok) {
            const data = await insightsResponse.json();
            insights = data.data?.[0] || null;
          }

          // ดึง Ads และรูปภาพ (Limit 10 ads per campaign)
          const adsResponse = await fetch(
            `https://graph.facebook.com/v19.0/${campaign.id}/ads?access_token=${accessToken}&fields=id,name,status&limit=10`
          );
          
          let ads = [];
          if (adsResponse.ok) {
            const adsData = await adsResponse.json();
            ads = adsData.data || [];
          }

          // ดึงรูปภาพ Creative (Limit 3 images per campaign to save bandwidth/quota)
          const adsWithImages = await Promise.all(
            ads.slice(0, 3).map(async (ad, i) => {
              if (i > 0) await new Promise(r => setTimeout(r, 20));
              try {
                const creativeRes = await fetch(
                  `https://graph.facebook.com/v19.0/${ad.id}/adcreatives?access_token=${accessToken}&fields=image_url,thumbnail_url,object_story_spec`
                );
                let images = [];
                if (creativeRes.ok) {
                  const creativeData = await creativeRes.json();
                  (creativeData.data || []).forEach(c => {
                    if (c.image_url) images.push({ type: 'image', url: c.image_url });
                    else if (c.object_story_spec?.link_data?.picture) {
                      images.push({ type: 'link_image', url: c.object_story_spec.link_data.picture });
                    }
                  });
                }
                return { ...ad, images };
              } catch (e) {
                return { ...ad, images: [] };
              }
            })
          );

          return {
            ...campaign,
            insights,
            ads: adsWithImages
          };

        } catch (error) {
          console.error(`Error processing campaign ${campaign.id}:`, error);
          return { ...campaign, error: error.message };
        }
      })
    );

    // ---------------------------------------------------------
    // 6. คำนวณ Totals และส่งค่ากลับ
    // ---------------------------------------------------------

    const totals = campaignsWithDetails.reduce((acc, campaign) => {
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
        campaigns: campaignsWithDetails
      }
    });

  } catch (error) {
    console.error('API Critical Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
