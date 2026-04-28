import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import kubernetesPlugin from '@backstage/plugin-kubernetes/alpha';
import { navModule } from './modules/nav';
import { githubAuthApiRef } from '@backstage/core-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { SignInPage } from '@backstage/core-components';
import { createFrontendModule } from '@backstage/frontend-plugin-api';

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
    (
      <SignInPage
        {...props}
        provider={{
          id: 'github-auth-provider',
          title: 'GitHub',
          message: 'Sign in using GitHub',
          apiRef: githubAuthApiRef,
        }}
      />
    ),
  },
});

const kubernetes = kubernetesPlugin.withOverrides({
  extensions: [
    kubernetesPlugin.getExtension('page:kubernetes').override({
      params: {
        loader: () =>
          import('./components/kubernetes/KubernetesHubPage').then(m => (
            <m.KubernetesHubPage />
          )),
      },
    }),
  ],
});

export default createApp({
  features: [
    catalogPlugin,
    navModule,
    kubernetes,
    createFrontendModule({
      pluginId: 'app',
      extensions: [signInPage],
    }),
  ],
});
