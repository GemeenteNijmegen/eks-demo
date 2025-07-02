import { KubectlV32Layer } from '@aws-cdk/lambda-layer-kubectl-v32';
import { GemeenteNijmegenVpc, PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Fn, Stack, StackProps } from 'aws-cdk-lib';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { BlockDeviceVolume, InstanceArchitecture, InstanceType, LaunchTemplate, Peer, Port, SecurityGroup, SubnetType, UserData } from 'aws-cdk-lib/aws-ec2';
import { FileSystem } from 'aws-cdk-lib/aws-efs';
import { Cluster, CpuArch, EksOptimizedImage, KubernetesVersion, NodeType } from 'aws-cdk-lib/aws-eks';
import { ApplicationLoadBalancer, ApplicationProtocol, ListenerAction, Protocol, SslPolicy } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { AaaaRecord, ARecord, HostedZone, RecordTarget, ZoneDelegationRecord } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import { loadAll } from 'js-yaml';

export class EksClusterStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Use permission boundary
    Aspects.of(this).add(new PermissionsBoundaryAspect());

    // Import landingzone managed VPC (with central egress);
    const vpc = new GemeenteNijmegenVpc(this, 'vpc');

    // Setup hostedzone
    const hostedzone = this.hostedzone();

    // Setup certificate
    const certificate = this.certificate(hostedzone);

    // A loadbalancer with a listener
    const alb = new ApplicationLoadBalancer(this, 'loadbalancer', {
      vpc: vpc.vpc,
      internetFacing: true,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
      },
    });

    const listener = alb.addListener('https', {
      protocol: ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: SslPolicy.TLS13_13,
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Woah something went wrong...',
      }),
    });

    // Make loadbalancer reachable with dns
    new ARecord(this, 'a-record', { //IPv4
      target: RecordTarget.fromAlias(new LoadBalancerTarget(alb)),
      zone: hostedzone,
    });
    new AaaaRecord(this, 'aaaa-record', { //IPv6
      target: RecordTarget.fromAlias(new LoadBalancerTarget(alb)),
      zone: hostedzone,
    });
    new ARecord(this, 'a-record-wildcard', { //IPv4
      target: RecordTarget.fromAlias(new LoadBalancerTarget(alb)),
      zone: hostedzone,
      recordName: `*.${hostedzone.zoneName}`,
    });
    new AaaaRecord(this, 'aaaa-record-wildcard', { //IPv6
      target: RecordTarget.fromAlias(new LoadBalancerTarget(alb)),
      zone: hostedzone,
      recordName: `*.${hostedzone.zoneName}`,
    });

    // The EKS cluster
    const cluster = new Cluster(this, 'cluster', {
      clusterName: 'EksCdkCluster',
      version: KubernetesVersion.V1_32,
      kubectlLayer: new KubectlV32Layer(this, 'kubectl'),
      vpc: vpc.vpc,
      defaultCapacity: 0,
      // serviceIpv4Cidr: '100.64.0.0/16', // Does not seem to do anything after creating the cluster
    });

    // Setup the group of nodes
    const nodeRole = new Role(this, 'node-role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryPullOnly'), // For pulling images
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'), // For attaching network interfaces to pods
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'), // For joining EKS cluster?
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedEC2InstanceDefaultPolicy'), // For SSM sessions manager
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEFSCSIDriverPolicy'), // Allows creation of storage ESF
      ],
    });
    cluster.awsAuth.addRoleMapping(nodeRole, {
      groups: ['system:bootstrappers', 'system:nodes'],
      username: 'system:node:{{EC2PrivateDNSName}}',
    });


    // Allow the Sandbox operator to do stuff in the cluster
    const sandboxOperator = Role.fromRoleArn(this, 'sandbox-operator', `arn:aws:iam::${Stack.of(this).account}:role/AWSReservedSSO_lz-sandbox-operator_6a487f913934ae52`)
    cluster.awsAuth.addRoleMapping(sandboxOperator, {
      groups: ['system:masters'],
      username: 'admin-role',
    });

    const userData = UserData.forLinux();
    userData.addCommands(
      'set -o xtrace',
      `sudo /etc/eks/bootstrap.sh ${cluster.clusterName}`,
      'sudo systemctl daemon-reexec',
      'sudo systemctl restart kubelet'
    );

    const sg = new SecurityGroup(this, 'node-sg', {
      vpc: vpc.vpc,
      allowAllOutbound: true,
    });

    sg.addIngressRule(Peer.anyIpv4(), Port.tcp(30080), 'Allow NodePort access');

    const instanceType = new InstanceType('t3.small');
    const launch = new LaunchTemplate(this, 'node-template-v2', {
      instanceType: instanceType,
      machineImage: new EksOptimizedImage({
        kubernetesVersion: '1.32',
        cpuArch: instanceType.architecture == InstanceArchitecture.ARM_64 ? CpuArch.ARM_64 : CpuArch.X86_64, // Something like this...
        nodeType: NodeType.STANDARD,
      }),
      role: nodeRole,
      userData: userData,
      securityGroup: sg,
      blockDevices: [
        {
          volume: BlockDeviceVolume.ebs(20, {
            encrypted: true,
          }),
          deviceName: '/dev/xvda', // I dont know why I need to do all this low level shit to get my ec2 instance up and running...
        }
      ],

    });

    const nodes = new AutoScalingGroup(this, 'nodes', {
      vpc: vpc.vpc,
      launchTemplate: launch,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      minCapacity: 1,
      desiredCapacity: 2,
      maxCapacity: 3,
    });

    // IMPORTANT: Allows the nodes to communicate with the Kubernetes API (which runs in a different security group than the nodes)
    cluster.clusterSecurityGroup.addIngressRule(Peer.securityGroupId(sg.securityGroupId), Port.allTcp());
    sg.addIngressRule(Peer.securityGroupId(cluster.clusterSecurityGroupId), Port.tcp(10250));
    sg.addIngressRule(Peer.securityGroupId(cluster.clusterSecurityGroupId), Port.allTcp());

    // From node to node
    sg.addIngressRule(sg, Port.tcpRange(1025, 65535));
    sg.addIngressRule(sg, Port.udpRange(1025, 65535));
    sg.addIngressRule(sg, Port.DNS_TCP);
    sg.addIngressRule(sg, Port.DNS_UDP);
    sg.addIngressRule(Peer.ipv4('10.100.0.10/32'), Port.allTcp());

    // Setup route ALB -> Ingress gateway
    listener.addTargets('ingress', {
      targets: [nodes],
      port: 30685,
      protocol: ApplicationProtocol.HTTP,
      healthCheck: {
        port: '30685',
        path: '/custom-healthz',
        healthyHttpCodes: '200-399,404',
        protocol: Protocol.HTTP,
      },
    });

    // Make sure that the LB can talk to the ec2 nodes
    const albSg = SecurityGroup.fromSecurityGroupId(this, 'alb-sg', Fn.select(0, alb.loadBalancerSecurityGroups)); // IDK why but this seems to compile instead of [0]...

    sg.connections.allowFrom(albSg, Port.tcp(31833), 'health check');
    sg.connections.allowFrom(albSg, Port.tcp(31852), 'https');
    sg.connections.allowFrom(albSg, Port.tcp(30685), 'http');

    // I think this is two way so lines above here might actually not be needed?
    alb.connections.allowTo(sg, Port.tcp(30685), 'http node port on k8s cluster');
    alb.connections.allowTo(sg, Port.tcp(31852), 'https node port on k8s cluster');

    // Allow communication in Sg
    sg.connections.allowFrom(sg, Port.allTcp());


    // Install some stuff on the cluster (such as a ingress gateway).

    // This controlls all our http routing in the cluster
    cluster.addHelmChart('nginx-ingress', {
      chart: 'ingress-nginx',
      repository: 'https://kubernetes.github.io/ingress-nginx',
      namespace: 'kube-system',
      release: 'nginx-ingress2',
      values: {
        controller: {
          replicaCount: 1,
          service: {
            type: 'NodePort',
            nodePorts: {
              http: 30080,    // Custom node port for HTTP (optional)
              https: 30443,   // Custom node port for HTTPS (optional)
            },
          },
        },
      },
    });

    cluster.addHelmChart('cert-manager', {
      chart: 'cert-manager',
      repository: 'https://charts.jetstack.io',
      namespace: 'cert-manager',
      release: 'cert-manager',
      values: {
        crds: {
          enabled: true,
        },
      },
    });

    cluster.addHelmChart('esf-csi', {
      chart: 'aws-efs-csi-driver',
      repository: 'https://kubernetes-sigs.github.io/aws-efs-csi-driver/',
      namespace: 'kube-system',
      release: 'esf-csi',
    });

    // A nice little game as a manifest that is applyed to the cluster
    const manifestPath = './2048.yaml';
    const manifestContents = readFileSync(manifestPath, 'utf8');
    const manifestObjects = loadAll(manifestContents) as any[];
    cluster.addManifest(`game-2048`, ...manifestObjects);


    const efs = new FileSystem(this, 'storage', {
      vpc: vpc.vpc,
      encrypted: true,
    });
    efs.connections.allowFrom(sg, Port.NFS);

  }


  private hostedzone() {
    const accountRootHostedZoneId: string = '/gemeente-nijmegen/account/hostedzone/id';
    const accountRootHostedZoneName: string = '/gemeente-nijmegen/account/hostedzone/name';
    const accountHostedzone = HostedZone.fromHostedZoneAttributes(this, 'account-hostedzone', {
      hostedZoneId: StringParameter.valueForStringParameter(this, accountRootHostedZoneId),
      zoneName: StringParameter.valueForStringParameter(this, accountRootHostedZoneName),
    });

    const subdomain = `eks-cdk-cluster.${accountHostedzone.zoneName}`;
    const hostedzone = new HostedZone(this, 'hostedzone', {
      zoneName: subdomain,
    });

    new ZoneDelegationRecord(this, 'zonedelegation', {
      nameServers: hostedzone.hostedZoneNameServers!,
      zone: accountHostedzone,
      recordName: subdomain,
    });

    return hostedzone;
  }


  private certificate(hostedzone: HostedZone) {
    // Note to self: wildcard cannot be a alternative name it seems...
    const certificate = new Certificate(this, 'certificate', {
      domainName: `*.${hostedzone.zoneName}`,
      subjectAlternativeNames: [
        hostedzone.zoneName
      ],
      validation: CertificateValidation.fromDns(),
      // Well this is mannually added (sorry)
      // Reason: The request contains an invalid set of changes for a resource record set
    });
    return certificate;
  }

}