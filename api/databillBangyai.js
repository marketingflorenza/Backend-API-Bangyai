export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const accessToken = process.env.FB_ACCESS_TOKEN;
    const adAccountId = process.env.AD_ACCOUNT_ID;

    if (!accessToken || !adAccountId) {
      return res.status(500).json({ success: false, error: 'Missing environment variables' });
    }

    const { since, until } = req.query;
    
    // Helper functions
    const convertDateFormat = (dateStr) => {
      if (!dateStr) return null;
      const parts = dateStr.split('-');
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    };
    const getUTCDateString = (date) => date.toISOString().split('T')[0];
    const getPurchases = (actions) => {
        if (!actions) return 0;
        const purchaseEventNames = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];
        const purchaseAction = actions.find(a => purchaseEventNames.includes(a.action_type));
        return purchaseAction ? parseInt(purchaseAction.value) : 0;
    };
    const getMessagingConversations = (actions) => {
        if (!actions) return 0;
        const messageAction = actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d');
        return messageAction ? parseInt(messageAction.value) : 0;
    };

    // Date range setup
    let dateStart, dateStop;
    const today = new Date();
    const thirtyDaysAgo = new Date(new Date().setDate(today.getDate() - 29));
    dateStart = since ? convertDateFormat(since) : getUTCDateString(thirtyDaysAgo);
    dateStop = until ? convertDateFormat(until) : getUTCDateString(today);
    
    const timeRange = encodeURIComponent(JSON.stringify({ since: dateStart, until: dateStop }));
    const insightFields = 'spend,impressions,clicks,inline_link_clicks,ctr,cpc,cpm,actions';

    // 1. Fetch aggregated totals
    const totalInsightsUrl = `https://graph.facebook.com/v19.0/${adAccountId}/insights?access_token=${accessToken}&fields=${insightFields}&time_range=${timeRange}&level=account&use_unified_attribution_setting=true`;
    const totalInsightsResponse = await fetch(totalInsightsUrl);
    const totalInsightsData = await totalInsightsResponse.json();
    const totals = totalInsightsData.data?.[0] || {};
    
    // 2. Fetch daily data for the chart
    const dailyInsightsUrl = `https://graph.facebook.com/v19.0/${adAccountId}/insights?access_token=${accessToken}&fields=spend&time_range=${timeRange}&level=account&time_increment=1`;
    const dailyInsightsResponse = await fetch(dailyInsightsUrl);
    const dailyInsightsData = await dailyInsightsResponse.json();
    const dailySpend = (dailyInsightsData.data || []).map(d => ({ date: d.date_start, spend: parseFloat(d.spend || 0) }));

    // 3. Fetch campaign and ad details
    const campaignStatuses = ['ACTIVE', 'INACTIVE', 'ARCHIVED', 'PAUSED', 'DELETED', 'COMPLETED'];
    const filtering = encodeURIComponent(JSON.stringify([{ field: 'effective_status', operator: 'IN', value: campaignStatuses }]));
    const campaignsResponse = await fetch(`https://graph.facebook.com/v19.0/${adAccountId}/campaigns?access_token=${accessToken}&fields=id,name,status&limit=100&filtering=${filtering}`);
    const campaignsData = await campaignsResponse.json();
    const campaigns = campaignsData.data || [];

    const campaignsWithDetails = await Promise.all(
      campaigns.map(async (campaign) => {
        // ✅ MODIFIED: Fetch ad-level data as the single source of truth for insights
        const adsUrl = `https://graph.facebook.com/v19.0/${campaign.id}/ads?access_token=${accessToken}&fields=name,adcreatives{thumbnail_url},insights.time_range(${timeRange}){${insightFields}}&limit=50`;
        const adsDataResponse = await fetch(adsUrl);
        const adsData = await adsDataResponse.json();
        
        const adsWithDetails = (adsData.data || []).map(ad => {
          const insight = ad.insights?.data?.[0];
          return {
            id: ad.id,
            name: ad.name,
            thumbnail_url: ad.adcreatives?.data[0]?.thumbnail_url || 'https://via.placeholder.com/150',
            insights: {
              spend: parseFloat(insight?.spend || 0),
              impressions: parseInt(insight?.impressions || 0),
              cpm: parseFloat(insight?.cpm || 0),
              purchases: getPurchases(insight?.actions),
              messaging_conversations: getMessagingConversations(insight?.actions),
            }
          };
        });

        // ✅ MODIFIED: Calculate campaign totals by summing up its ads
        const campaignInsights = adsWithDetails.reduce((acc, ad) => {
            acc.spend += ad.insights.spend;
            acc.impressions += ad.insights.impressions;
            acc.purchases += ad.insights.purchases;
            acc.messaging_conversations += ad.insights.messaging_conversations;
            return acc;
        }, { spend: 0, impressions: 0, purchases: 0, messaging_conversations: 0 });

        // Recalculate CPM for the campaign total
        campaignInsights.cpm = campaignInsights.impressions > 0 ? (campaignInsights.spend / campaignInsights.impressions) * 1000 : 0;

        return { ...campaign, insights: campaignInsights, ads: adsWithDetails };
      })
    );

    res.status(200).json({
      success: true,
      totals: {
        spend: parseFloat(totals.spend || 0),
        impressions: parseInt(totals.impressions || 0),
        clicks: parseInt(totals.clicks || 0),
        inline_link_clicks: parseInt(totals.inline_link_clicks || 0),
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
