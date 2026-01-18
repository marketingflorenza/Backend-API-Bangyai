
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const accessToken = process.env.FB_ACCESS_TOKEN;
    const adAccountId = process.env.AD_ACCOUNT_ID;

    if (!accessToken || !adAccountId) {
      return res.status(500).json({ 
        error: 'Missing environment variables',
        success: false
      });
    }

    // First, get ad account timezone information
    let adAccountTimezone = null;
    try {
      console.log('Fetching ad account timezone information...');
      const accountResponse = await fetch(
        `https://graph.facebook.com/v19.0/${adAccountId}?access_token=${accessToken}&fields=timezone_id,timezone_name,timezone_offset_hours_utc`
      );
      
      if (accountResponse.ok) {
        const accountData = await accountResponse.json();
        if (!accountData.error) {
          adAccountTimezone = accountData;
          console.log('Ad Account Timezone:', adAccountTimezone);
        } else {
          console.error('Facebook API Error getting timezone:', accountData.error);
        }
      } else {
        console.error('Failed to fetch ad account timezone:', accountResponse.status);
      }
    } catch (error) {
      console.error('Error fetching ad account timezone:', error);
    }

    // รับค่าช่วงเวลาจาก query parameters
    const { since, until } = req.query;
    
    // ฟังก์ชันแปลงวันที่จาก DD-MM-YYYY เป็น YYYY-MM-DD
    function convertDateFormat(dateStr) {
      if (!dateStr) return null;
      
      const parts = dateStr.split('-');
      if (parts.length !== 3) return null;
      
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2];
      
      // ตรวจสอบว่าเป็นตัวเลขหรือไม่
      if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
      if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1900) return null;
      
      return `${year}-${month}-${day}`;
    }

    // ฟังก์ชันแปลงวันที่จาก YYYY-MM-DD กลับเป็น DD-MM-YYYY
    function formatDateForResponse(dateStr) {
      if (!dateStr) return null;
      const parts = dateStr.split('-');
      if (parts.length !== 3) return dateStr;
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }

    // ฟังก์ชันสำหรับสร้างวันที่ในรูปแบบ YYYY-MM-DD โดยใช้ UTC
    function getUTCDateString(date) {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    // กำหนดค่า default โดยคำนึงถึง timezone ของ ad account
    const now = new Date();
    
    // Facebook API ใช้ timezone ของ ad account (ไม่ใช่ UTC)
    // เราต้องปรับให้ตรงกับ timezone ของ ad account
    let timezoneOffset = 0; // Default UTC
    if (adAccountTimezone && adAccountTimezone.timezone_offset_hours_utc) {
      timezoneOffset = parseFloat(adAccountTimezone.timezone_offset_hours_utc);
      console.log(`Using ad account timezone offset: ${timezoneOffset} hours`);
    } else {
      console.log('Using UTC timezone (default)');
    }
    
    // คำนวณเวลาในโซนเวลาของ ad account
    const accountNow = new Date(now.getTime() + (timezoneOffset * 60 * 60 * 1000));
    const today = new Date(accountNow.getUTCFullYear(), accountNow.getUTCMonth(), accountNow.getUTCDate());
    const thirtyDaysAgo = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000));
    
    let dateStart, dateStop;
    let originalSince = since;
    let originalUntil = until;
    
    if (since) {
      const convertedSince = convertDateFormat(since);
      if (!convertedSince) {
        return res.status(400).json({
          success: false,
          error: 'Invalid since date format. Use DD-MM-YYYY format (e.g., 31-01-2024)'
        });
      }
      dateStart = convertedSince;
    } else {
      dateStart = getUTCDateString(thirtyDaysAgo);
      originalSince = formatDateForResponse(dateStart);
    }
    
    if (until) {
      const convertedUntil = convertDateFormat(until);
      if (!convertedUntil) {
        return res.status(400).json({
          success: false,
          error: 'Invalid until date format. Use DD-MM-YYYY format (e.g., 31-01-2024)'
        });
      }
      dateStop = convertedUntil;
    } else {
      // Facebook API: until date หมายถึงวันสุดท้ายที่รวมในการคำนวณ (inclusive)
      // ใช้วันปัจจุบันตาม timezone ของ ad account
      dateStop = getUTCDateString(today);
      originalUntil = formatDateForResponse(dateStop);
    }

    // Validate date range
    const startDate = new Date(dateStart + 'T00:00:00.000Z');
    const endDate = new Date(dateStop + 'T00:00:00.000Z');
    
    if (startDate > endDate) {
      return res.status(400).json({
        success: false,
        error: 'Start date must be before end date'
      });
    }

    // ตรวจสอบว่าไม่ได้ขอข้อมูลย้อนหลังเกินไป (Facebook API มีข้อจำกัดเรื่องข้อมูลเก่า)
    const maxDaysBack = 1095; // Facebook API อนุญาตให้ดึงข้อมูลย้อนหลังได้ประมาณ 3 ปี
    const maxDate = new Date(today.getTime() - (maxDaysBack * 24 * 60 * 60 * 1000));
    
    if (startDate < maxDate) {
      return res.status(400).json({
        success: false,
        error: `Date range cannot be more than ${maxDaysBack} days ago`
      });
    }

    // ตรวจสอบว่าไม่ได้ขอข้อมูลอนาคต
    if (startDate > today) {
      return res.status(400).json({
        success: false,
        error: 'Start date cannot be in the future'
      });
    }

    console.log(`Fetching Facebook API data for date range: ${dateStart} to ${dateStop}`);

    // ดึงข้อมูล campaigns
    const campaignsResponse = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/campaigns?access_token=${accessToken}&fields=id,name,status,objective,created_time,updated_time&limit=50`
    );

    if (!campaignsResponse.ok) {
      const errorText = await campaignsResponse.text();
      console.error('Facebook API campaigns error:', errorText);
      throw new Error(`Facebook API campaigns error: ${campaignsResponse.status} - ${errorText}`);
    }

    const campaignsData = await campaignsResponse.json();
    
    // ตรวจสอบ error จาก Facebook API
    if (campaignsData.error) {
      console.error('Facebook API Error:', campaignsData.error);
      throw new Error(`Facebook API Error: ${campaignsData.error.message} (Code: ${campaignsData.error.code})`);
    }

    const campaigns = campaignsData.data || [];
    console.log(`Found ${campaigns.length} campaigns`);

    // ตรวจสอบว่าควรใช้ date_preset หรือ time_range
    const isLast30Days = dateStart === getUTCDateString(thirtyDaysAgo) && dateStop === getUTCDateString(today);

    // ดึงข้อมูลสำหรับแต่ละ campaign
    const campaignsWithDetails = await Promise.all(
      campaigns.map(async (campaign, index) => {
        try {
          // เพิ่ม delay เล็กน้อยเพื่อป้องกัน rate limit
          if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }

          // Alternative: Use date_preset for better consistency
          // For recent data, you might want to use date_preset instead of time_range
          let insightsUrl;
          if (isLast30Days) {
            // Use preset for standard 30-day range (more reliable)
            insightsUrl = `https://graph.facebook.com/v19.0/${campaign.id}/insights?access_token=${accessToken}&fields=spend,impressions,clicks,reach,ctr,cpc,cpm,frequency,actions,cost_per_action_type&date_preset=last_30d&level=campaign`;
            console.log(`Using date_preset=last_30d for campaign ${campaign.id}`);
          } else {
            // Use custom time range
            const timeRange = encodeURIComponent(JSON.stringify({
              since: dateStart,
              until: dateStop
            }));
            insightsUrl = `https://graph.facebook.com/v19.0/${campaign.id}/insights?access_token=${accessToken}&fields=spend,impressions,clicks,reach,ctr,cpc,cpm,frequency,actions,cost_per_action_type&time_range=${timeRange}&level=campaign`;
            console.log(`Using custom time_range for campaign ${campaign.id}: ${dateStart} to ${dateStop}`);
          }
          
          console.log(`Fetching insights for campaign ${campaign.id}`);
          
          const insightsResponse = await fetch(insightsUrl);
          
          let insights = null;
          if (insightsResponse.ok) {
            const insightsData = await insightsResponse.json();
            if (insightsData.error) {
              console.error(`Insights error for campaign ${campaign.id}:`, insightsData.error);
            } else {
              insights = insightsData.data?.[0] || null;
              if (insights) {
                console.log(`Got insights for campaign ${campaign.id}: spend=${insights.spend}, impressions=${insights.impressions}`);
              } else {
                console.log(`No insights data for campaign ${campaign.id}`);
              }
            }
          } else {
            const errorText = await insightsResponse.text();
            console.error(`Insights API error for campaign ${campaign.id}:`, insightsResponse.status, errorText);
          }

          // ดึง ads ของ campaign
          const adsResponse = await fetch(
            `https://graph.facebook.com/v19.0/${campaign.id}/ads?access_token=${accessToken}&fields=id,name,status,created_time,updated_time&limit=10`
          );

          let ads = [];
          if (adsResponse.ok) {
            const adsData = await adsResponse.json();
            if (adsData.error) {
              console.error(`Ads error for campaign ${campaign.id}:`, adsData.error);
            } else {
              ads = adsData.data || [];
            }
          } else {
            const errorText = await adsResponse.text();
            console.error(`Ads API error for campaign ${campaign.id}:`, adsResponse.status, errorText);
          }

          // ดึงรูปภาพของ ads (จำกัดจำนวนเพื่อป้องกัน rate limit)
          const adsWithImages = await Promise.all(
            ads.slice(0, 3).map(async (ad, adIndex) => { // จำกัดที่ 3 ads เพื่อป้องกัน rate limit
              try {
                // เพิ่ม delay เล็กน้อย
                if (adIndex > 0) {
                  await new Promise(resolve => setTimeout(resolve, 50));
                }

                const creativesResponse = await fetch(
                  `https://graph.facebook.com/v19.0/${ad.id}/adcreatives?access_token=${accessToken}&fields=id,name,object_story_spec,image_url,thumbnail_url&limit=2`
                );

                let images = [];
                if (creativesResponse.ok) {
                  const creativesData = await creativesResponse.json();
                  if (creativesData.error) {
                    console.error(`Creatives error for ad ${ad.id}:`, creativesData.error);
                  } else {
                    const creatives = creativesData.data || [];
                    
                    for (const creative of creatives) {
                      if (creative.image_url) {
                        images.push({
                          type: 'image',
                          url: creative.image_url,
                          thumbnail: creative.thumbnail_url || creative.image_url
                        });
                      }
                      
                      if (creative.object_story_spec?.link_data?.picture) {
                        images.push({
                          type: 'link_image',
                          url: creative.object_story_spec.link_data.picture,
                          thumbnail: creative.object_story_spec.link_data.picture
                        });
                      }
                    }
                  }
                } else {
                  const errorText = await creativesResponse.text();
                  console.error(`Creatives API error for ad ${ad.id}:`, creativesResponse.status, errorText);
                }

                return {
                  ...ad,
                  images: images
                };
              } catch (error) {
                console.error(`Error fetching ad images for ${ad.id}:`, error);
                return {
                  ...ad,
                  images: []
                };
              }
            })
          );

          return {
            ...campaign,
            insights: insights,
            ads: adsWithImages
          };

        } catch (error) {
          console.error(`Error fetching campaign details for ${campaign.id}:`, error);
          return {
            ...campaign,
            insights: null,
            ads: [],
            error: error.message
          };
        }
      })
    );

    // คำนวณ totals
    const totals = campaignsWithDetails.reduce((acc, campaign) => {
      if (campaign.insights) {
        acc.totalSpend += parseFloat(campaign.insights.spend || 0);
        acc.totalImpressions += parseInt(campaign.insights.impressions || 0);
        acc.totalClicks += parseInt(campaign.insights.clicks || 0);
        acc.totalReach += parseInt(campaign.insights.reach || 0);
      }
      return acc;
    }, {
      totalSpend: 0,
      totalImpressions: 0,
      totalClicks: 0,
      totalReach: 0
    });

    const totalImages = campaignsWithDetails.reduce((count, campaign) => {
      return count + campaign.ads.reduce((adCount, ad) => {
        return adCount + (ad.images?.length || 0);
      }, 0);
    }, 0);

    // Return response with proper success structure
    res.status(200).json({
      success: true,
      message: 'Facebook API data retrieved successfully',
      dateRange: {
        start: formatDateForResponse(dateStart) || originalSince,
        end: formatDateForResponse(dateStop) || originalUntil,
        requested: {
          since: originalSince,
          until: originalUntil
        },
        facebook_api_format: {
          since: dateStart,
          until: dateStop
        },
        timezone_info: {
          server_time: new Date().toISOString(),
          range_days: Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1,
          ad_account_timezone: adAccountTimezone || { 
            timezone_name: 'UTC (default)', 
            timezone_offset_hours_utc: 0,
            note: 'Ad account timezone could not be retrieved'
          },
          used_date_preset: isLast30Days
        }
      },
      summary: {
        totalCampaigns: campaignsWithDetails.length,
        totalAds: campaignsWithDetails.reduce((count, c) => count + (c.ads?.length || 0), 0),
        totalImages: totalImages,
        campaignsWithInsights: campaignsWithDetails.filter(c => c.insights).length,
        campaignsWithErrors: campaignsWithDetails.filter(c => c.error).length
      },
      totals: {
        spend: parseFloat(totals.totalSpend.toFixed(2)),
        impressions: totals.totalImpressions,
        clicks: totals.totalClicks,
        reach: totals.totalReach,
        ctr: totals.totalImpressions > 0 ? parseFloat(((totals.totalClicks / totals.totalImpressions) * 100).toFixed(2)) : 0,
        cpc: totals.totalClicks > 0 ? parseFloat((totals.totalSpend / totals.totalClicks).toFixed(2)) : 0,
        cpm: totals.totalImpressions > 0 ? parseFloat(((totals.totalSpend / totals.totalImpressions) * 1000).toFixed(2)) : 0
      },
      data: {
        campaigns: campaignsWithDetails.map(campaign => ({
          ...campaign,
          insights: campaign.insights ? {
            ...campaign.insights,
            spend: Math.round(parseFloat(campaign.insights.spend || 0) * 100) / 100,
            impressions: parseInt(campaign.insights.impressions || 0),
            clicks: parseInt(campaign.insights.clicks || 0),
            reach: parseInt(campaign.insights.reach || 0),
            ctr: Math.round(parseFloat(campaign.insights.ctr || 0) * 100) / 100,
            cpc: Math.round(parseFloat(campaign.insights.cpc || 0) * 100) / 100,
            cpm: Math.round(parseFloat(campaign.insights.cpm || 0) * 100) / 100
          } : null
        }))
      }
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Check server logs for more information',
      timestamp: new Date().toISOString(),
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
