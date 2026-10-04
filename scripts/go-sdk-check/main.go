// Runs every GET in the official Meraki Go SDK against the emulator.
//
//	cd scripts/go-sdk-check && go run .
//
// The SDK drops JSON decode errors, so each answer is decoded again into the
// SDK's own response type and any type mismatch is reported. Fields the SDK
// type doesn't have are listed with -fields. Exits 1 if any call fails.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/go-resty/resty/v2"
	meraki "github.com/meraki/dashboard-api-go/v5/sdk"
)

const (
	sdkModule = "github.com/meraki/dashboard-api-go/v5"
	apiKey    = "sdk-check-key-0000"
)

// One SDK GET method: its service field, name, path template and the
// placeholder each string argument fills, in order.
type method struct {
	service, name, path string
	params              []string
}

var placeholder = regexp.MustCompile(`\{\w+\}`)

// SDK GETs the emulator has no route for, and why.
var unrouted = map[string]string{
	"GetDeviceCameraAnalyticsLive":                              "deprecated in the spec",
	"GetDeviceCameraAnalyticsOverview":                          "deprecated in the spec",
	"GetDeviceCameraAnalyticsRecent":                            "deprecated in the spec",
	"GetDeviceCameraAnalyticsZoneHistory":                       "deprecated in the spec",
	"GetDeviceCameraAnalyticsZones":                             "deprecated in the spec",
	"GetOrganizationInventoryOnboardingCloudMonitoringImports":  "no longer in the spec",
	"GetOrganizationInventoryOnboardingCloudMonitoringNetworks": "no longer in the spec",
}

// Known failures, each with the reason. The run fails if one of these passes,
// so the list stays current.
var known = map[string]string{
	// The SDK's types disagree with the spec, and the emulator follows the spec.
	"GetDeviceClients":                                            "SDK types vlan as an integer; the spec says string",
	"GetNetworkApplianceVLAN":                                     "SDK types id as an integer; the spec says string",
	"GetNetworkApplianceVLANs":                                    "SDK types id as an integer; the spec says string",
	"GetNetworkSwitchRoutingOspf":                                 "SDK types areas[].areaId as an integer; the spec says string",
	"GetNetworkSyslogServers":                                     "SDK types servers[].port as a string; the spec says integer",
	"GetNetworkTopologyLinkLayer":                                 "SDK types discovered.cdp as a string; the spec says object",
	"GetNetworkWirelessAirMarshal":                                "SDK types channels as strings; the spec says integers",
	"GetDeviceWirelessLatencyStats":                               "SDK types each traffic class as a string; the spec says object",
	"GetNetworkWirelessClientLatencyStats":                        "SDK types each traffic class as a string; the spec says object",
	"GetNetworkWirelessClientsLatencyStats":                       "SDK types each traffic class as a string; the spec says object",
	"GetNetworkWirelessDevicesLatencyStats":                       "SDK types each traffic class as a string; the spec says object",
	"GetNetworkWirelessLatencyStats":                              "SDK types each traffic class as a string; the spec says object",
	"GetOrganizationApplianceVpnStatuses":                         "SDK expects an object; the spec says a list",
	"GetOrganizationCellularGatewayEsimsServiceProvidersAccounts": "SDK expects an object; the spec says a list",
	"GetOrganizationSwitchPortsBySwitch":                          "SDK expects an object; the spec says a list",
	"GetOrganizationWebhooksAlertTypes":                           "SDK expects an object; the spec says a list",
	// The spec's schema is one object, but these are lists.
	"GetAdministeredLicensingSubscriptionEntitlements": "the spec shows one entitlement; the emulator lists them",
	"GetOrganizationEarlyAccessFeaturesOptIns":         "the spec shows one opt-in; the emulator lists them",
	// The SDK's query type has no way to send ranges[]startTime and the rest.
	"GetOrganizationCameraDetectionsHistoryByBoundaryByInterval": "SDK can't send the required ranges[] query",
}

func main() {
	fields := flag.Bool("fields", false, "also list answer fields the SDK types don't have")
	only := flag.String("only", "", "run only methods whose name matches this regexp")
	flag.Parse()

	methods, err := sdkMethods()
	if err != nil {
		fatal(err)
	}
	base, samples, stop, err := startEmulator()
	if err != nil {
		fatal(err)
	}
	defer stop()

	client, err := meraki.NewClientWithOptionsAndRequests(base, apiKey, "false", "go-sdk-check", 1000)
	if err != nil {
		fatal(err)
	}
	// The SDK prints a line per call and logs every error; keep only ours.
	log.SetOutput(io.Discard)

	// Emulator samples keyed by path with placeholders blanked, since the SDK
	// and the spec sometimes name a path parameter differently.
	byShape := map[string]string{}
	for p, u := range samples {
		byShape[placeholder.ReplaceAllString(p, "{}")] = u
	}

	var filter *regexp.Regexp
	if *only != "" {
		filter = regexp.MustCompile(*only)
	}
	var failures, extras, stale []string
	ran, skips, knownHits, missing := 0, 0, 0, []string{}
	for _, m := range methods {
		if filter != nil && !filter.MatchString(m.name) {
			continue
		}
		sample, ok := byShape[placeholder.ReplaceAllString(strings.TrimPrefix(m.path, "/api/v1"), "{}")]
		if !ok {
			if _, skip := unrouted[m.name]; !skip {
				missing = append(missing, m.name+" "+m.path)
			}
			continue
		}
		ran++
		problem, extra := call(client, m, sample)
		_, isKnown := known[m.name]
		switch {
		case problem == skipped:
			skips++
		case problem != "" && isKnown:
			knownHits++
		case problem != "":
			failures = append(failures, fmt.Sprintf("%s %s\n    %s", m.name, sample, problem))
		case problem == "" && isKnown:
			stale = append(stale, m.name)
		}
		if extra != "" {
			extras = append(extras, fmt.Sprintf("%s: %s", m.name, extra))
		}
	}

	if *fields {
		for _, e := range extras {
			fmt.Println("extra field", e)
		}
	}
	for _, f := range failures {
		fmt.Println("FAIL", f)
	}
	for _, n := range stale {
		fmt.Println("PASSES, remove from known:", n)
	}
	if len(missing) > 0 {
		fmt.Printf("%d SDK GETs have no emulator route:\n", len(missing))
		for _, m := range missing {
			fmt.Println("  " + m)
		}
	}
	fmt.Printf("%d SDK GETs run: %d failed, %d known, %d need data the default world lacks, %d have fields the SDK doesn't model; %d without a route\n",
		ran, len(failures), knownHits, skips, len(extras), len(missing))
	if len(failures) > 0 || len(missing) > 0 || len(stale) > 0 {
		os.Exit(1)
	}
}

// call runs one method with the sample's path values and query, then decodes
// the body again into the method's result type.
func call(client *meraki.Client, m method, sample string) (problem, extra string) {
	u, err := url.Parse(sample)
	if err != nil {
		return err.Error(), ""
	}
	values, err := pathValues(m.path, u.Path)
	if err != nil {
		return err.Error(), ""
	}
	fn := reflect.ValueOf(client).Elem().FieldByName(m.service).MethodByName(m.name)
	ft := fn.Type()
	args := make([]reflect.Value, ft.NumIn())
	for i := range args {
		t := ft.In(i)
		if t.Kind() == reflect.String {
			args[i] = reflect.ValueOf(values[m.params[i]])
			continue
		}
		q := reflect.New(t.Elem())
		if err := fillQuery(q.Elem(), u.Query()); err != nil {
			return err.Error(), ""
		}
		args[i] = q
	}

	out := quiet(func() []reflect.Value { return fn.Call(args) })
	resp := out[len(out)-2].Interface().(*resty.Response)
	if e := out[len(out)-1]; !e.IsNil() {
		if resp == nil {
			return firstLine(e.Interface().(error).Error()), ""
		}
		// A sample that fails without the SDK too only needs data the
		// default world doesn't have.
		if status, err := rawStatus(resp.Request.URL, sample); err == nil && status == resp.StatusCode() {
			return skipped, ""
		}
		return fmt.Sprintf("%d %s %s", resp.StatusCode(), resp.Request.URL, firstLine(string(resp.Body()))), ""
	}
	body := resp.Body()
	if len(body) == 0 || len(out) < 3 {
		return "", ""
	}
	result := reflect.New(ft.Out(0).Elem())
	if err := json.Unmarshal(body, result.Interface()); err != nil {
		return "decode: " + err.Error(), ""
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(reflect.New(ft.Out(0).Elem()).Interface()); err != nil {
		return "", err.Error()
	}
	return "", ""
}

const skipped = "skipped"

// rawStatus fetches the sample on the SDK's host with plain HTTP.
func rawStatus(sdkURL, sample string) (int, error) {
	u, err := url.Parse(sdkURL)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequest("GET", u.Scheme+"://"+u.Host+"/api/v1"+sample, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	res.Body.Close()
	return res.StatusCode, nil
}

// pathValues reads the placeholder values out of a concrete path.
func pathValues(template, path string) (map[string]string, error) {
	t := strings.Split(strings.TrimPrefix(template, "/api/v1"), "/")
	p := strings.Split(strings.TrimPrefix(path, "/api/v1"), "/")
	if len(t) != len(p) {
		return nil, fmt.Errorf("path %s doesn't fit %s", path, template)
	}
	values := map[string]string{}
	for i, seg := range t {
		if placeholder.MatchString(seg) {
			v, err := url.PathUnescape(p[i])
			if err != nil {
				return nil, err
			}
			values[seg] = v
		}
	}
	return values, nil
}

// fillQuery sets the query struct's fields from the sample's query string by
// their url tags.
func fillQuery(v reflect.Value, q url.Values) error {
	for i := 0; i < v.NumField(); i++ {
		name := strings.Split(v.Type().Field(i).Tag.Get("url"), ",")[0]
		vals, ok := q[name]
		if !ok || len(vals) == 0 {
			continue
		}
		f := v.Field(i)
		var err error
		switch f.Kind() {
		case reflect.String:
			f.SetString(vals[0])
		case reflect.Int, reflect.Int64:
			var n int64
			n, err = strconv.ParseInt(vals[0], 10, 64)
			f.SetInt(n)
		case reflect.Float64:
			var n float64
			n, err = strconv.ParseFloat(vals[0], 64)
			f.SetFloat(n)
		case reflect.Bool:
			var b bool
			b, err = strconv.ParseBool(vals[0])
			f.SetBool(b)
		case reflect.Slice:
			f.Set(reflect.ValueOf(vals))
		default:
			err = fmt.Errorf("query field %s has kind %s", name, f.Kind())
		}
		if err != nil {
			return fmt.Errorf("query %s=%s: %w", name, vals[0], err)
		}
	}
	return nil
}

// sdkMethods reads the SDK's source for its GET methods, since reflection
// can't see parameter names or path templates.
func sdkMethods() ([]method, error) {
	dir, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", sdkModule).Output()
	if err != nil {
		return nil, fmt.Errorf("go list %s: %w", sdkModule, err)
	}
	files, err := filepath.Glob(filepath.Join(strings.TrimSpace(string(dir)), "sdk", "*.go"))
	if err != nil {
		return nil, err
	}
	var methods []method
	fset := token.NewFileSet()
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			return nil, err
		}
		for _, d := range f.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Recv == nil || !strings.HasPrefix(fd.Name.Name, "Get") || fd.Body == nil {
				continue
			}
			if m, ok := getMethod(fd); ok {
				methods = append(methods, m)
			}
		}
	}
	sort.Slice(methods, func(i, j int) bool { return methods[i].name < methods[j].name })
	return methods, nil
}

// getMethod reads `path := "..."` and the strings.Replace calls that fill it.
func getMethod(fd *ast.FuncDecl) (method, bool) {
	star, ok := fd.Recv.List[0].Type.(*ast.StarExpr)
	if !ok {
		return method{}, false
	}
	recv := star.X.(*ast.Ident).Name
	m := method{service: strings.TrimSuffix(recv, "Service"), name: fd.Name.Name}
	fills := map[string]string{}
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.AssignStmt:
			if id, ok := n.Lhs[0].(*ast.Ident); ok && id.Name == "path" && n.Tok == token.DEFINE {
				if lit, ok := n.Rhs[0].(*ast.BasicLit); ok {
					m.path, _ = strconv.Unquote(lit.Value)
				}
			}
		case *ast.CallExpr:
			sel, ok := n.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Replace" || len(n.Args) < 3 {
				return true
			}
			lit, ok1 := n.Args[1].(*ast.BasicLit)
			arg, ok2 := n.Args[2].(*ast.CallExpr)
			if ok1 && ok2 && len(arg.Args) == 2 {
				if id, ok := arg.Args[1].(*ast.Ident); ok {
					ph, _ := strconv.Unquote(lit.Value)
					fills[id.Name] = ph
				}
			}
		}
		return true
	})
	if m.path == "" {
		return method{}, false
	}
	for _, field := range fd.Type.Params.List {
		for _, name := range field.Names {
			m.params = append(m.params, fills[name.Name])
		}
	}
	return m, true
}

// startEmulator runs serve.mjs and reads its base URL and samples.
func startEmulator() (string, map[string]string, func(), error) {
	cmd := exec.Command("node", "serve.mjs")
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", nil, nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return "", nil, nil, err
	}
	stop := func() {
		stdin.Close()
		cmd.Wait()
	}
	r := bufio.NewReader(stdout)
	line, err := r.ReadBytes('\n')
	if err != nil {
		stop()
		return "", nil, nil, fmt.Errorf("emulator did not start: %w", err)
	}
	var info struct {
		Base    string            `json:"base"`
		Samples map[string]string `json:"samples"`
	}
	if err := json.Unmarshal(line, &info); err != nil {
		stop()
		return "", nil, nil, err
	}
	return info.Base, info.Samples, stop, nil
}

// quiet runs f with stdout sent nowhere, for the SDK's per-call prints.
func quiet[T any](f func() T) T {
	saved := os.Stdout
	null, _ := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	os.Stdout = null
	defer func() {
		os.Stdout = saved
		null.Close()
	}()
	return f()
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	return s
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
