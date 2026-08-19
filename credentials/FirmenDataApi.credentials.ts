import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  Icon,
  INodeProperties,
} from 'n8n-workflow';

export class FirmenDataApi implements ICredentialType {
  name = 'firmenDataApi';

  displayName = 'FirmenData API';

  icon: Icon = { light: 'file:firmendata.svg', dark: 'file:firmendata.dark.svg' };

  documentationUrl = 'https://api.firmendata.com/v1/docs';

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'Create one at firmendata.com under Account → API Keys. The free plan includes 100 credits.',
      placeholder: 'firmendata_live_...',
    },
  ];

  authenticate: IAuthenticateGeneric = {
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
  test: ICredentialTestRequest = {
    request: {
      baseURL: 'https://api.firmendata.com',
      url: '/v1/companies/autocomplete',
      qs: { q: 'test' },
    },
  };
}
