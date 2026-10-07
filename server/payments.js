const manualPaymentProvider = {
  id: 'manual',
  onlinePaymentsConfigured: false,
  getOptions() {
    return [
      { id: 'pay_on_site', label: 'Paiement sur place', available: true },
      { id: 'online', label: 'Paiement en ligne bientôt disponible', available: false }
    ];
  },
  createPaymentIntent() {
    return {
      provider: this.id,
      configured: false,
      status: 'PAY_ON_SITE'
    };
  }
};

module.exports = { manualPaymentProvider };
