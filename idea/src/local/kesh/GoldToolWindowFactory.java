package local.kesh;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jetbrains.annotations.NotNull;
import javax.swing.*;
import java.awt.*;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.prefs.Preferences;
import java.util.concurrent.atomic.AtomicBoolean;

public class GoldToolWindowFactory implements ToolWindowFactory {
  public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
    Panel panel = new Panel();
    Content content = toolWindow.getContentManager().getFactory().createContent(panel, "", false);
    content.setDisposer(panel);
    toolWindow.getContentManager().addContent(content);
  }
  static class Panel extends JPanel implements Disposable {
    final Preferences prefs = Preferences.userRoot().node("local/kesh/gold");
    final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
    final JLabel buy=new JLabel("--"), change=new JLabel("--"), sell=new JLabel("--"), percent=new JLabel("--"), time=new JLabel("--"), status=new JLabel("等待报价"), error=new JLabel(" ");
    final long started = System.currentTimeMillis();
    final AtomicBoolean busy=new AtomicBoolean();
    final Timer seconds;
    long next=0; String state="等待报价"; volatile boolean disposed=false;
    Panel() {
      setLayout(new GridBagLayout());
      JPanel card=new JPanel(new GridBagLayout());
      card.setBorder(BorderFactory.createEmptyBorder(8,10,8,10));
      GridBagConstraints c=new GridBagConstraints();
      c.anchor=GridBagConstraints.WEST; c.fill=GridBagConstraints.HORIZONTAL; c.weightx=1; c.gridx=0; c.gridy=0;
      JPanel header=new JPanel(new BorderLayout(8,0));
      JPanel price=new JPanel(new FlowLayout(FlowLayout.LEFT,0,0));
      buy.setFont(buy.getFont().deriveFont(Font.PLAIN,27f)); price.add(buy); price.add(Box.createHorizontalStrut(8)); price.add(change);
      header.add(price,BorderLayout.WEST);
      JPanel buttons=new JPanel(new FlowLayout(FlowLayout.RIGHT,4,0));
      JButton refresh=new JButton("刷新"), settings=new JButton("设置"); buttons.add(refresh); buttons.add(settings); header.add(buttons,BorderLayout.EAST);
      card.add(header,c);
      c.gridy++; c.insets=new Insets(2,0,0,0); card.add(new JLabel("实时买入价（元/克）"),c);
      JPanel values=new JPanel(new GridLayout(1,2,16,0));
      JPanel left=new JPanel(new GridLayout(2,1)); left.add(new JLabel("今日涨跌幅")); left.add(percent);
      JPanel right=new JPanel(new GridLayout(2,1)); right.add(new JLabel("实时卖出价（元/克）")); right.add(sell);
      values.add(left); values.add(right); c.gridy++; c.insets=new Insets(9,0,0,0); card.add(values,c);
      c.gridy++; c.insets=new Insets(7,0,0,0); card.add(time,c);
      c.gridy++; c.insets=new Insets(3,0,0,0); card.add(status,c);
      c.gridy++; c.insets=new Insets(2,0,0,0); card.add(error,c);
      GridBagConstraints outer=new GridBagConstraints(); outer.gridx=0; outer.gridy=0; outer.weightx=1; outer.weighty=1; outer.anchor=GridBagConstraints.SOUTHEAST; outer.insets=new Insets(0,0,10,10); add(card,outer);
      refresh.addActionListener(e->fetch()); settings.addActionListener(e->settings());
      seconds=new Timer(1000,e->{long elapsed=(System.currentTimeMillis()-started)/1000; status.setText(state+" · 等待"+format(elapsed));if(System.currentTimeMillis()>=next)fetch();});seconds.start(); fetch();
    }
    int interval(){return Math.max(1,prefs.getInt("seconds",5));}
    void settings(){ JTextField url=new JTextField(prefs.get("url","https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center")); JTextField params=new JTextField(prefs.get("params","[{\"prdType\":\"H\",\"prdCode\":\"\"}]")); JTextField key=new JTextField(prefs.get("key","FQAMBPRCZ1")); JTextField sec=new JTextField(Integer.toString(interval())); JPanel form=new JPanel(new GridLayout(0,1)); for(Component c:new Component[]{new JLabel("接口地址"),url,new JLabel("请求参数 JSON"),params,new JLabel("报价对象字段"),key,new JLabel("刷新间隔（秒）"),sec})form.add(c);if(JOptionPane.showConfirmDialog(this,form,"行情设置",JOptionPane.OK_CANCEL_OPTION)==JOptionPane.OK_OPTION){try{int n=Integer.parseInt(sec.getText().trim()); if(n<1)throw new IllegalArgumentException(); URI u=URI.create(url.getText().trim());if(!"https".equals(u.getScheme())&&!"http".equals(u.getScheme()))throw new IllegalArgumentException(); JsonParser.parseString(params.getText());prefs.put("url",u.toString());prefs.put("params",params.getText());prefs.put("key",key.getText().trim());prefs.putInt("seconds",n);fetch();}catch(Exception ex){JOptionPane.showMessageDialog(this,"请检查接口地址、JSON 和刷新间隔。显式使用 HTTP 或 HTTPS，间隔至少为 1 秒。");}} }
    void fetch(){if(disposed||!busy.compareAndSet(false,true))return;next=Long.MAX_VALUE;try{String url=prefs.get("url","https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center"), params=prefs.get("params","[{\"prdType\":\"H\",\"prdCode\":\"\"}]");String body="params="+URLEncoder.encode(params,StandardCharsets.UTF_8);HttpRequest req=HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(15)).header("Content-Type","application/x-www-form-urlencoded").header("Accept","application/json, text/plain, */*").header("Origin","https://mbmodulecdn.cmbimg.com").header("Referer","https://mbmodulecdn.cmbimg.com/").header("X-Requested-With","cmb.pb").header("User-Agent","Mozilla/5.0").POST(HttpRequest.BodyPublishers.ofString(body)).build();client.sendAsync(req,HttpResponse.BodyHandlers.ofString()).whenComplete((response,ex)->SwingUtilities.invokeLater(()->{try{if(disposed)return;if(ex!=null)throw new RuntimeException(ex.getMessage());if(response.statusCode()!=200)throw new RuntimeException("HTTP "+response.statusCode());JsonObject result=JsonParser.parseString(response.body()).getAsJsonObject();if(!result.get("success").getAsBoolean())throw new RuntimeException(result.has("msg")?result.get("msg").getAsString():"接口失败");JsonObject data=result.getAsJsonObject("data"),q=data.getAsJsonObject(prefs.get("key","FQAMBPRCZ1"));buy.setText(val(q,"zBuyPrc"));sell.setText(val(q,"zSelPrc"));colored(change,val(q,"zDvlCur"),"");colored(percent,val(q,"zPrcDif"),"%");time.setText("报价时间："+val(data,"NowTime"));state=(data.get("MarketDay").getAsBoolean()?"交易日":"非交易日")+" · "+(data.get("QuotedPrice").getAsBoolean()?"报价有效":"报价无效")+" · "+interval()+"秒刷新";error.setText(" ");}catch(Exception e){error.setText("刷新失败："+e.getMessage());}finally{busy.set(false);next=System.currentTimeMillis()+interval()*1000L;}}));}catch(Exception e){busy.set(false);next=System.currentTimeMillis()+interval()*1000L;error.setText("刷新失败："+e.getMessage());}}
    static String val(JsonObject o,String k){return o!=null&&o.has(k)&&!o.get(k).isJsonNull()?o.get(k).getAsString():"--";}
    static void colored(JLabel l,String s,String suffix){try{double n=Double.parseDouble(s);l.setText((n>0&&!s.startsWith("+")?"+":"")+s+suffix);l.setForeground(n>0?new Color(220,65,75):n<0?new Color(38,168,62):UIManager.getColor("Label.foreground"));}catch(Exception e){l.setText("--");}}
    static String format(long s){StringBuilder b=new StringBuilder();long[] n={86400,3600,60,1};String[] u={"天","小时","分","秒"};for(int i=0;i<n.length;i++){long v=s/n[i];s%=n[i];if(v>0)b.append(v).append(u[i]);}return b.length()==0?"0秒":b.toString();}
    public void dispose(){disposed=true;seconds.stop();}
  }
}
