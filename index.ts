import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as cloudflare from '@pulumi/cloudflare'
import { execSync } from 'child_process'

const config = new pulumi.Config()

// =============================================================================
// Configuration
// =============================================================================
const ECR_REGISTRY = '066047414165.dkr.ecr.ap-northeast-2.amazonaws.com'
const AWS_REGION = 'ap-northeast-2'
const DOMAIN = 'picouncil.com'
const environment = 'production'

// Cloudflare
const cloudflareAccountId = config.require('cloudflareAccountId')
const cloudflareZoneId = config.require('cloudflareZoneId')

// =============================================================================
// Image Tag Strategy
// =============================================================================
function getGitCommit(projectPath: string): string {
  try {
    const commit = execSync(`git -C ${projectPath} rev-parse --short HEAD`, {
      encoding: 'utf-8',
    }).trim()
    return commit
  } catch {
    return 'latest'
  }
}

const serverCommit = getGitCommit('../picouncil-server')
const serverImage =
  config.get('serverImage') || `${ECR_REGISTRY}/picouncil-server:${serverCommit}`

console.log(`Server image: ${serverImage}`)

// =============================================================================
// Cloudflare R2 (Image Storage)
// =============================================================================
const imagesBucket = new cloudflare.R2Bucket('picouncil-images', {
  accountId: cloudflareAccountId,
  name: 'picouncil-images',
  location: 'APAC',
})

// R2 Public Access
new cloudflare.R2ManagedDomain('picouncil-images-public', {
  accountId: cloudflareAccountId,
  bucketName: imagesBucket.name,
  enabled: true,
})

// R2 Custom Domain (images.picouncil.com)
new cloudflare.R2CustomDomain('picouncil-images-domain', {
  accountId: cloudflareAccountId,
  bucketName: imagesBucket.name,
  domain: `images.${DOMAIN}`,
  zoneId: cloudflareZoneId,
  enabled: true,
  minTls: '1.2',
})

// =============================================================================
// Cloudflare DNS
// =============================================================================
// Root domain → Vercel
new cloudflare.DnsRecord('picouncil-root', {
  zoneId: cloudflareZoneId,
  name: '@',
  type: 'A',
  content: '216.198.79.1',
  proxied: false,
  ttl: 1,
})

// www → Vercel (will update after vercel domain setup)
new cloudflare.DnsRecord('picouncil-www', {
  zoneId: cloudflareZoneId,
  name: 'www',
  type: 'CNAME',
  content: 'picouncil-web-pied.vercel.app',
  proxied: false,
  ttl: 1,
})

// admin → Vercel
new cloudflare.DnsRecord('picouncil-admin-dns', {
  zoneId: cloudflareZoneId,
  name: 'admin',
  type: 'CNAME',
  content: 'picouncil-admin.vercel.app',
  proxied: false,
  ttl: 1,
})

// =============================================================================
// Cloudflare Tunnel (api.picouncil.com → EC2:8080)
// =============================================================================
const tunnelSecret = config.requireSecret('cloudflareTunnelSecret')

const apiTunnel = new cloudflare.ZeroTrustTunnelCloudflared('picouncil-api-tunnel', {
  accountId: cloudflareAccountId,
  name: 'picouncil-api-tunnel',
  tunnelSecret: tunnelSecret,
  configSrc: 'cloudflare',
})

new cloudflare.ZeroTrustTunnelCloudflaredConfig('picouncil-api-tunnel-config', {
  accountId: cloudflareAccountId,
  tunnelId: apiTunnel.id,
  config: {
    ingresses: [
      {
        hostname: `api.${DOMAIN}`,
        service: 'http://localhost:8080',
      },
      {
        service: 'http_status:404',
      },
    ],
  },
})

// api.picouncil.com DNS → Tunnel
new cloudflare.DnsRecord('picouncil-api-dns', {
  zoneId: cloudflareZoneId,
  name: 'api',
  type: 'CNAME',
  content: pulumi.interpolate`${apiTunnel.id}.cfargotunnel.com`,
  proxied: true,
  ttl: 1,
})

const tunnelToken = cloudflare.getZeroTrustTunnelCloudflaredTokenOutput({
  accountId: cloudflareAccountId,
  tunnelId: apiTunnel.id,
})

// =============================================================================
// AWS VPC (Simple - single public subnet)
// =============================================================================
const vpc = new aws.ec2.Vpc('picouncil-vpc', {
  cidrBlock: '10.0.0.0/16',
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: { Name: 'picouncil-vpc' },
})

const subnet = new aws.ec2.Subnet('picouncil-subnet', {
  vpcId: vpc.id,
  cidrBlock: '10.0.1.0/24',
  availabilityZone: `${AWS_REGION}a`,
  mapPublicIpOnLaunch: true,
  tags: { Name: 'picouncil-subnet' },
})

const internetGateway = new aws.ec2.InternetGateway('picouncil-igw', {
  vpcId: vpc.id,
  tags: { Name: 'picouncil-igw' },
})

const routeTable = new aws.ec2.RouteTable('picouncil-rt', {
  vpcId: vpc.id,
  routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: internetGateway.id }],
  tags: { Name: 'picouncil-rt' },
})

new aws.ec2.RouteTableAssociation('picouncil-rt-assoc', {
  subnetId: subnet.id,
  routeTableId: routeTable.id,
})

// Security Group (SSH only - Cloudflare Tunnel handles HTTPS)
const securityGroup = new aws.ec2.SecurityGroup('picouncil-sg', {
  description: 'PICouncil ECS Security Group',
  vpcId: vpc.id,
  ingress: [
    { protocol: 'tcp', fromPort: 22, toPort: 22, cidrBlocks: ['0.0.0.0/0'], description: 'SSH' },
  ],
  egress: [
    { protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'], description: 'All outbound' },
  ],
  tags: { Name: 'picouncil-sg' },
})

// =============================================================================
// IAM Roles
// =============================================================================
const ecsInstanceRole = new aws.iam.Role('picouncil-ecs-instance-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  }),
})

new aws.iam.RolePolicyAttachment('picouncil-ecs-instance-ecs', {
  role: ecsInstanceRole.name,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role',
})

new aws.iam.RolePolicyAttachment('picouncil-ecs-instance-ssm', {
  role: ecsInstanceRole.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
})

const ecsInstanceProfile = new aws.iam.InstanceProfile('picouncil-ecs-instance-profile', {
  role: ecsInstanceRole.name,
})

const ecsTaskExecutionRole = new aws.iam.Role('picouncil-task-execution-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  }),
})

new aws.iam.RolePolicyAttachment('picouncil-task-execution-ecs', {
  role: ecsTaskExecutionRole.name,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
})

new aws.iam.RolePolicyAttachment('picouncil-task-execution-ecr', {
  role: ecsTaskExecutionRole.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
})

const awsAccountId = aws.getCallerIdentity().then((id) => id.accountId)

new aws.iam.RolePolicy('picouncil-task-execution-ssm', {
  role: ecsTaskExecutionRole.name,
  policy: awsAccountId.then((accountId) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['ssm:GetParameters', 'ssm:GetParameter'],
          Resource: `arn:aws:ssm:${AWS_REGION}:${accountId}:parameter/picouncil/*`,
        },
      ],
    })
  ),
})

// =============================================================================
// SSM Parameters (Secrets)
// =============================================================================
const databaseUrl = config.requireSecret('database-url')
const jwtSecret = config.requireSecret('jwt-secret')

new aws.ssm.Parameter('picouncil-DATABASE_URL', {
  name: '/picouncil/DATABASE_URL',
  type: 'SecureString',
  value: databaseUrl,
  tags: { Environment: environment },
})

new aws.ssm.Parameter('picouncil-JWT_SECRET', {
  name: '/picouncil/JWT_SECRET',
  type: 'SecureString',
  value: jwtSecret,
  tags: { Environment: environment },
})

// =============================================================================
// ECR Repository
// =============================================================================
const ecrRepository = new aws.ecr.Repository('picouncil-server', {
  name: 'picouncil-server',
  imageTagMutability: 'MUTABLE',
  imageScanningConfiguration: { scanOnPush: true },
  tags: { Name: 'picouncil-server' },
})

new aws.ecr.LifecyclePolicy('picouncil-server-lifecycle', {
  repository: ecrRepository.name,
  policy: JSON.stringify({
    rules: [{
      rulePriority: 1,
      description: 'Keep last 10 images',
      selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 10 },
      action: { type: 'expire' },
    }],
  }),
})

// =============================================================================
// CloudWatch Log Group
// =============================================================================
const logGroup = new aws.cloudwatch.LogGroup('picouncil-logs', {
  name: '/ecs/picouncil-server',
  retentionInDays: 14,
})

// =============================================================================
// ECS Cluster
// =============================================================================
const ecsCluster = new aws.ecs.Cluster('picouncil-cluster', {
  name: 'picouncil-cluster',
  settings: [{ name: 'containerInsights', value: 'disabled' }],
})

// =============================================================================
// ECS Task Definition
// =============================================================================
const taskDefinition = new aws.ecs.TaskDefinition('picouncil-server-task', {
  family: 'picouncil-server',
  networkMode: 'bridge',
  requiresCompatibilities: ['EC2'],
  executionRoleArn: ecsTaskExecutionRole.arn,
  containerDefinitions: logGroup.name.apply((logGroupName) =>
    JSON.stringify([{
      name: 'picouncil-server',
      image: serverImage,
      essential: true,
      memory: 256,
      cpu: 128,
      portMappings: [{ containerPort: 8080, hostPort: 8080, protocol: 'tcp' }],
      environment: [
        { name: 'PORT', value: '8080' },
        { name: 'ENVIRONMENT', value: 'production' },
        { name: 'FRONTEND_URL', value: `https://${DOMAIN}` },
      ],
      secrets: [
        { name: 'DATABASE_URL', valueFrom: '/picouncil/DATABASE_URL' },
        { name: 'JWT_SECRET', valueFrom: '/picouncil/JWT_SECRET' },
      ],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': logGroupName,
          'awslogs-region': AWS_REGION,
          'awslogs-stream-prefix': 'ecs',
        },
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget -q --spider http://localhost:8080/health || exit 1'],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 60,
      },
    }])
  ),
  tags: { Name: 'picouncil-server-task' },
})

// =============================================================================
// EC2 Instance (t4g.nano - cheapest ARM instance ~$3/month)
// =============================================================================
const instanceType = config.get('instanceType') || 't4g.nano'

const ecsAmi = aws.ssm.getParameter({
  name: '/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id',
}).then((p) => p.value)

const userData = pulumi.all([ecsCluster.name, tunnelToken.token]).apply(([clusterName, token]) =>
  Buffer.from(`#!/bin/bash
echo ECS_CLUSTER=${clusterName} >> /etc/ecs/ecs.config

# Install cloudflared (ARM64)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

cat > /etc/systemd/system/cloudflared.service << EOF
[Unit]
Description=Cloudflare Tunnel
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token ${token}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cloudflared
systemctl start cloudflared
`).toString('base64')
)

const ecsInstance = new aws.ec2.Instance('picouncil-ecs-instance', {
  ami: ecsAmi,
  instanceType: instanceType,
  iamInstanceProfile: ecsInstanceProfile.name,
  subnetId: subnet.id,
  vpcSecurityGroupIds: [securityGroup.id],
  userData: userData,
  associatePublicIpAddress: true,
  rootBlockDevice: { volumeSize: 30, volumeType: 'gp3' },
  tags: { Name: 'picouncil-ecs-instance' },
})

// =============================================================================
// ECS Service
// =============================================================================
new aws.ecs.Service('picouncil-server-service', {
  name: 'picouncil-server',
  cluster: ecsCluster.arn,
  taskDefinition: taskDefinition.arn,
  desiredCount: 1,
  launchType: 'EC2',
  deploymentMinimumHealthyPercent: 0,
  deploymentMaximumPercent: 100,
  tags: { Name: 'picouncil-server-service' },
})

// =============================================================================
// Outputs
// =============================================================================
export const vpcId = vpc.id
export const ecrRepositoryUrl = ecrRepository.repositoryUrl
export const ecsClusterArn = ecsCluster.arn
export const instancePublicIp = ecsInstance.publicIp
export const r2BucketName = imagesBucket.name
export const apiUrl = `https://api.${DOMAIN}`
export const webUrl = `https://${DOMAIN}`
export const adminUrl = `https://admin.${DOMAIN}`
