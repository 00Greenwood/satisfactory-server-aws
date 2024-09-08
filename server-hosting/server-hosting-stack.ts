import { Duration, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Config } from "./config";
import {
  IVpc,
  Vpc,
  SubnetSelection,
  Subnet,
  SubnetType,
  SecurityGroup,
  Peer,
  Port,
  Instance,
  InstanceType,
  MachineImage,
  BlockDeviceVolume,
  InstanceClass,
  InstanceSize,
} from "aws-cdk-lib/aws-ec2";
import { Bucket, IBucket } from "aws-cdk-lib/aws-s3";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  LambdaIntegration,
  LambdaRestApi,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { Runtime } from "aws-cdk-lib/aws-lambda";

type HandlerType = "Start" | "Stop" | "Reboot";

const createLambda = (
  stack: Stack,
  restApi: RestApi,
  instanceId: string,
  handler: HandlerType
) => {
  const lambda = new NodejsFunction(
    stack,
    `${Config.prefix}${handler}ServerLambda`,
    {
      entry: `./server-hosting/lambda/${handler.toLowerCase()}.ts`,
      description: `${handler} game server`,
      timeout: Duration.seconds(10),
      environment: {
        INSTANCE_ID: instanceId,
      },
      runtime: Runtime.NODEJS_20_X,
    }
  );

  lambda.addToRolePolicy(
    new PolicyStatement({
      actions: [`ec2:${handler}Instances`],
      resources: [`arn:aws:ec2:*:${Config.account}:instance/${instanceId}`],
    })
  );

  const resource = restApi.root.addResource(handler.toLowerCase());
  resource.addMethod("GET", new LambdaIntegration(lambda));
};

export class ServerHostingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // prefix for all resources in this stack
    const prefix = Config.prefix;

    //////////////////////////////////////////
    // Configure server, network and security
    //////////////////////////////////////////

    let lookUpOrDefaultVpc = (vpcId: string): IVpc => {
      // lookup vpc if given
      if (vpcId) {
        return Vpc.fromLookup(this, `${prefix}Vpc`, {
          vpcId,
        });

        // use default vpc otherwise
      } else {
        return Vpc.fromLookup(this, `${prefix}Vpc`, {
          isDefault: true,
        });
      }
    };

    let publicOrLookupSubnet = (
      subnetId: string,
      availabilityZone: string
    ): SubnetSelection => {
      // if subnet id is given select it
      if (subnetId && availabilityZone) {
        return {
          subnets: [
            Subnet.fromSubnetAttributes(this, `${Config.prefix}ServerSubnet`, {
              availabilityZone,
              subnetId,
            }),
          ],
        };

        // else use any available public subnet
      } else {
        return { subnetType: SubnetType.PUBLIC };
      }
    };

    const vpc = lookUpOrDefaultVpc(Config.vpcId);
    const vpcSubnets = publicOrLookupSubnet(
      Config.subnetId,
      Config.availabilityZone
    );

    // configure security group to allow ingress access to game ports
    const securityGroup = new SecurityGroup(
      this,
      `${prefix}ServerSecurityGroup`,
      {
        vpc,
        description: "Allow Satisfactory client to connect to server",
      }
    );

    securityGroup.addIngressRule(Peer.anyIpv4(), Port.udp(7777), "Game port");
    securityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.udp(15000),
      "Beacon port"
    );
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.udp(15777), "Query port");

    const server = new Instance(this, `${prefix}Server`, {
      // 4 vCPU, 16 GB RAM should be enough for most factories
      instanceType: new InstanceType(
        `${InstanceClass.M5A}.${InstanceSize.XLARGE}`
      ),
      // get exact ami from parameter exported by canonical
      // https://discourse.ubuntu.com/t/finding-ubuntu-images-with-the-aws-ssm-parameter-store/15507
      machineImage: MachineImage.fromSsmParameter(
        "/aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id"
      ),
      // storage for steam, satisfactory and save files
      blockDevices: [
        {
          deviceName: "/dev/sda1",
          volume: BlockDeviceVolume.ebs(30),
        },
      ],
      // server needs a public ip to allow connections
      vpcSubnets,
      userDataCausesReplacement: true,
      vpc,
      securityGroup,
    });

    // Add Base SSM Permissions, so we can use AWS Session Manager to connect to our server, rather than external SSH.
    server.role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    //////////////////////////////
    // Configure save bucket
    //////////////////////////////

    let findOrCreateBucket = (bucketName: string): IBucket => {
      // if bucket already exists lookup and use the bucket
      if (bucketName) {
        return Bucket.fromBucketName(this, `${prefix}SavesBucket`, bucketName);
        // if bucket does not exist create a new bucket
        // autogenerate name to reduce possibility of conflict
      } else {
        return new Bucket(this, `${prefix}SavesBucket`);
      }
    };

    // allow server to read and write save files to and from save bucket
    const savesBucket = findOrCreateBucket(Config.bucketName);
    savesBucket.grantReadWrite(server.role);

    //////////////////////////////
    // Configure instance startup
    //////////////////////////////

    // add aws cli
    // needed to download install script asset and
    // perform backups to s3
    server.userData.addCommands("sudo apt-get install unzip -y");
    server.userData.addCommands(
      'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && unzip awscliv2.zip && ./aws/install'
    );

    // package startup script and grant read access to server
    const startupScript = new Asset(this, `${Config.prefix}InstallAsset`, {
      path: "./server-hosting/scripts/install.sh",
    });
    startupScript.grantRead(server.role);

    // download and execute startup script
    // with save bucket name as argument
    const localPath = server.userData.addS3DownloadCommand({
      bucket: startupScript.bucket,
      bucketKey: startupScript.s3ObjectKey,
    });
    server.userData.addExecuteFileCommand({
      filePath: localPath,
      arguments: `${savesBucket.bucketName} ${Config.useExperimentalBuild}`,
    });

    //////////////////////////////
    // Add api to start server
    //////////////////////////////

    if (Config.restartApi && Config.restartApi === true) {
      const restApi = new RestApi(this, `${prefix}ServerApi`);
      createLambda(this, restApi, server.instanceId, "Start");
      createLambda(this, restApi, server.instanceId, "Stop");
      createLambda(this, restApi, server.instanceId, "Reboot");
    }
  }
}
