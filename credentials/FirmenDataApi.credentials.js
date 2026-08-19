"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FirmenDataApi = void 0;
var FirmenDataApi = /** @class */ (function () {
    function FirmenDataApi() {
        this.name = 'firmenDataApi';
        this.displayName = 'FirmenData API';
        this.icon = { light: 'file:firmendata.svg', dark: 'file:firmendata.dark.svg' };
        this.documentationUrl = 'https://api.firmendata.com/v1/docs';
        this.properties = [
            {
                displayName: 'API Key',
                name: 'apiKey',
                type: 'string',
                typeOptions: { password: true },
                default: '',
                required: true,
                description: 'Create one at firmendata.com under Account → API Keys. The free plan includes 100 credits.',
                placeholder: 'firmendata_live_...',
            },
        ];
        this.authenticate = {
            type: 'generic',
            properties: {
                headers: {
                    Authorization: '=Bearer {{$credentials.apiKey}}',
                },
            },
        };
        // Autocomplete costs 0 credits, so pressing "Test" in the UI never spends
        // the user's balance — and because it is the one endpoint that also works
        // unauthenticated, an invalid key still fails loudly: a bad token is
        // rejected as 401 rather than silently downgraded to the keyless tier.
        this.test = {
            request: {
                baseURL: 'https://api.firmendata.com',
                url: '/v1/companies/autocomplete',
                qs: { q: 'test' },
            },
        };
    }
    return FirmenDataApi;
}());
exports.FirmenDataApi = FirmenDataApi;
