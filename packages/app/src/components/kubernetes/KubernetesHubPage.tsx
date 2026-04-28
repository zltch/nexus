import { Content, Header, Page } from '@backstage/core-components';
import { ClusterWideDashboard } from './KubernetesClusterDashboard';

/**
 * Top-level `/kubernetes` page. The plugin default calls `useEntity()` outside
 * the catalog layout and crashes; this page replaces it with a cluster-wide
 * dashboard plus catalog deep links.
 */
export function KubernetesHubPage() {
  return (
    <Page themeId="home">
      <Header
        title="Kubernetes"
        subtitle="Cluster-wide visibility (workloads, services, namespaces)"
      />
      <Content>
        <ClusterWideDashboard />
      </Content>
    </Page>
  );
}
