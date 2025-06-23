import { GemeenteNijmegenCdkApp } from '@gemeentenijmegen/projen-project-type';
const project = new GemeenteNijmegenCdkApp({
  cdkVersion: '2.1.0',
  defaultReleaseBranch: 'main',
  devDeps: ['@gemeentenijmegen/projen-project-type'],
  name: 'experiment-eks',
  projenrcTs: true,
  deps: [
    '@aws-cdk/lambda-layer-kubectl-v32',
    '@gemeentenijmegen/aws-constructs',
    'js-yaml',
    '@types/js-yaml'
  ],
});
project.synth();