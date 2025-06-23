import { App } from 'aws-cdk-lib';
import { EksClusterStack } from './EksClusterStack';

const sandbox = {
  account: '049753832279',
  region: 'eu-central-1',
};

const app = new App();

new EksClusterStack(app, 'experiment-eks-cdk', { env: sandbox });

app.synth();