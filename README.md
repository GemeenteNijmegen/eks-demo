# First attempt at deploying a kubernetes cluster on EKS


- Uses nginx ingress controler (in-cluster) and a ALB oudside the cluster that forwards all traffic to EC2 nodes.
- Runs the 2048 game (deployed using a manifest)
- Uses EFS for provisioning ReadWriteMany Persistent Volume Claims (PVCs)


## Overview
![Overview](./docs/overview.drawio.png)


## Haven compliancy
Running the haven compliancy checker on this setup results in the following verdict:

```plain
+----------------+--------------------------------------------------------------------------+--------+
|    CATEGORY    |                                   NAME                                   | PASSED |
+----------------+--------------------------------------------------------------------------+--------+
| Fundamental    | Self test: HCC version is latest major or within 3 months upgrade window | YES    |
| Fundamental    | Self test: does HCC have cluster-admin                                   | YES    |
| Infrastructure | Multiple availability zones in use                                       | YES    |
| Infrastructure | Running at least 3 master nodes                                          | YES    |
| Infrastructure | Running at least 3 worker nodes                                          | NO     |
| Infrastructure | Nodes have SELinux, Grsecurity, AppArmor, LKRG, Talos or Flatcar enabled | NO     |
| Infrastructure | Private networking topology                                              | YES    |
| Cluster        | Kubernetes version is latest stable or max 3 minor versions behind       | YES    |
| Cluster        | Role Based Access Control is enabled                                     | YES    |
| Cluster        | Basic auth is disabled                                                   | YES    |
| Cluster        | ReadWriteMany persistent volumes support                                 | YES    |
| External       | CNCF Kubernetes Conformance                                              | NO     |
| Deployment     | Automated HTTPS certificate provisioning                                 | YES    |
| Deployment     | Log aggregation is running                                               | NO     |
| Deployment     | Metrics-server is running                                                | NO     |
| Validation     | SHA has been validated                                                   | YES    |
+----------------+--------------------------------------------------------------------------+--------+
```