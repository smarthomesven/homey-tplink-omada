const axios = require('axios');

module.exports = {
  async getDebugData({ homey}) {
    const app = homey.app;

    if (!await app._ensureSession()) {
      return { error: 'Session could not be established' };
    }

    // Fetch all sites
    const sitesRes = await app._client.get(`/${app._cid}/api/v2/user/sites?currentPage=1&currentPageSize=100&filters.needFavorite=true`, {
      headers: {
        'Csrf-Token': app._csrfToken,
      },
    });
    const sites = sitesRes.data?.result?.data ?? [];

    const sitesWithClients = await Promise.all(sites.map(async (site) => {
      try {
        const clientsRes = await app._client.post(
          `/openapi/v2/${app._cid}/sites/${site.id}/clients`,
          {
            page: 1,
            pageSize: 500,
            scope: 1,
            sorts: {},
            hideHealthUnsupported: true,
            filters: { active: true },
          },
          {
            headers: {
              'Csrf-Token': app._csrfToken,
              'Omada-Request-Source': 'web-local',
              'X-Requested-With': 'XMLHttpRequest',
            },
          }
        );

        return {
          siteId: site.id,
          siteName: site.name,
          clients: clientsRes.data?.result?.data ?? [],
        };
      } catch (err) {
        return {
          siteId: site.id,
          siteName: site.name,
          clientsError: err.message,
        };
      }
    }));

    return sitesWithClients;
  },

  async send({ homey, body }) {
    try {
      const { message, deviceId, deviceName, data } = body;

      if (!message || !data) {
        throw new Error('Missing required fields');
      }

      const response = await axios.post('https://device-support-requests.vercel.app/api/send-report', {
        message: message,
        app: 'TP-Link Omada',
        report: {
          deviceId: deviceId,
          deviceName: deviceName,
          data: data
        }
      });

      return {
        success: true,
        id: response.data.id
      };
    } catch (error) {
      this.homey.app.error('Error sending to support:', error.message);
      throw new Error(error.response?.data?.error || error.message);
    }
  }
};